import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SubscriptionDatabase } from "../src/database"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// The deployed binding-tracking schema, including its historical nullable PR column
// and legacy defaults. Do not derive this fixture from the new schema.
function previousDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amp-bindings-"))
  directories.push(directory)
  const path = join(directory, "relay.sqlite")
  const sqlite = new Database(path, { create: true })
  sqlite.exec(`
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, repository TEXT NOT NULL,
      pull_request_number INTEGER,
      target_type TEXT CHECK(target_type IN ('pull_request', 'branch', 'repository')),
      target TEXT, webhook_url TEXT NOT NULL, events TEXT NOT NULL,
      behavior TEXT NOT NULL, created_at TEXT NOT NULL,
      webhook_binding TEXT NOT NULL DEFAULT 'legacy' CHECK(webhook_binding IN ('legacy', 'thread_v1')),
      UNIQUE(thread_id, repository, target_type, target),
      UNIQUE(thread_id, repository, pull_request_number)
    );
    CREATE TABLE deliveries (
      subscription_id TEXT NOT NULL, delivery_id TEXT NOT NULL, event TEXT NOT NULL,
      delivered_at TEXT NOT NULL, PRIMARY KEY(subscription_id, delivery_id, event),
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    );
    CREATE TABLE feed_subscriptions (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, feed_url TEXT NOT NULL,
      webhook_url TEXT NOT NULL, behavior TEXT NOT NULL, etag TEXT, last_modified TEXT,
      created_at TEXT NOT NULL,
      webhook_binding TEXT NOT NULL DEFAULT 'legacy' CHECK(webhook_binding IN ('legacy', 'thread_v1')),
      UNIQUE(thread_id, feed_url)
    );
    CREATE TABLE feed_entries (
      subscription_id TEXT NOT NULL, entry_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      seen_at TEXT NOT NULL, PRIMARY KEY(subscription_id, entry_id),
      FOREIGN KEY(subscription_id) REFERENCES feed_subscriptions(id) ON DELETE CASCADE
    );
    INSERT INTO subscriptions VALUES ('gh', 'T-test', 'lox/project', 17, 'pull_request', '17',
      'https://hooks.example.test/thread', '["reviews"]', 'implement', '2026-09-01', 'thread_v1');
    INSERT INTO deliveries VALUES ('gh', 'delivery-1', 'reviews', '2026-09-02');
    INSERT INTO feed_subscriptions VALUES ('feed', 'T-test', 'https://status.example/feed',
      'https://hooks.example.test/thread', 'notify', 'etag-1', 'modified-1', '2026-09-01', 'thread_v1');
    INSERT INTO feed_entries VALUES ('feed', 'entry-1', 'version-1', '2026-09-02');
  `)
  return { sqlite, path }
}

describe("SubscriptionDatabase", () => {
  test("opens the fully migrated deployed schema and preserves subscriptions, history and feed baselines", () => {
    const { sqlite, path } = previousDatabase()
    sqlite.close()
    let database = new SubscriptionDatabase(path)
    const github = database.list("T-test")[0]!
    const feed = database.listFeeds("T-test")[0]!
    expect(github).toMatchObject({ id: "gh", targetType: "pull_request", pullRequestNumber: 17, behavior: "implement" })
    expect(feed).toMatchObject({ id: "feed", etag: "etag-1", lastModified: "modified-1" })
    expect(database.upsert({ ...github, webhookUrl: "https://hooks.example.test/updated" }).id).toBe("gh")
    // New PRs must work with the previous schema's extra unique PR-number column.
    for (const pullRequestNumber of [18, 19]) {
      database.upsert({ ...github, targetType: "pull_request", pullRequestNumber })
    }
    const url = "https://hooks.example.test/refreshed"
    expect(database.updateWebhook("T-test", url)).toEqual({ github: 3, feed: 1 })
    expect(database.updateWebhook("T-test", url)).toEqual({ github: 0, feed: 0 })
    database.close()
    database = new SubscriptionDatabase(path)
    expect(database.matching("lox/project", "pull_request", "17", "reviews"))
      .toEqual([{ ...github, webhookUrl: url }])
    expect(database.listFeeds("T-test")).toEqual([{ ...feed, webhookUrl: url }])
    expect(database.wasDelivered("gh", "delivery-1", "reviews")).toBe(true)
    expect(database.feedEntryChanged("feed", {
      id: "entry-1", fingerprint: "version-1", title: null, url: null, publishedAt: null, updatedAt: null,
    })).toBe(false)
    expect(database.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    database.delete("T-test", "gh")
    database.deleteFeed("T-test", "feed")
    expect(database.sqlite.query("SELECT * FROM deliveries").all()).toEqual([])
    expect(database.sqlite.query("SELECT * FROM feed_entries").all()).toEqual([])
    database.close()
  })

  test.each(["subscriptions", "feed_subscriptions"])("refuses remaining legacy rows in %s without mutating them", (table) => {
    const { sqlite, path } = previousDatabase()
    sqlite.exec(`UPDATE ${table} SET webhook_binding = 'legacy'`)
    const before = sqlite.query(`SELECT * FROM ${table}`).all()
    sqlite.close()
    expect(() => new SubscriptionDatabase(path)).toThrow("finish thread_v1 migration")
    const check = new Database(path, { readonly: true })
    expect(check.query(`SELECT * FROM ${table}`).all()).toEqual(before)
    expect(check.query("SELECT * FROM deliveries").all()).toHaveLength(1)
    expect(check.query("SELECT * FROM feed_entries").all()).toHaveLength(1)
    check.close()
  })

  test.each([
    "ALTER TABLE subscriptions DROP COLUMN webhook_binding",
    "ALTER TABLE feed_subscriptions DROP COLUMN webhook_binding",
    "UPDATE subscriptions SET target_type = NULL, target = NULL",
  ])("refuses pre-tracking schemas and rollback rows: %s", (change) => {
    const { sqlite, path } = previousDatabase()
    sqlite.exec(change)
    sqlite.close()
    expect(() => new SubscriptionDatabase(path)).toThrow("finish thread_v1 migration")
  })

  test("stores and matches one repository subscription per thread and repository", () => {
    const database = new SubscriptionDatabase(":memory:")
    const subscription = database.upsert({
      threadId: "T-test", repository: "lox/project", targetType: "repository",
      webhookUrl: "https://hooks.example.test/repository", events: ["pull_requests", "issues"], behavior: "notify",
    })
    expect(database.list("T-test")).toEqual([subscription])
    expect(database.matching("LOX/PROJECT", "repository", "*", "issues")).toEqual([subscription])
    expect(database.matching("lox/project", "repository", "*", "reviews")).toEqual([])
    const updated = database.upsert({
      threadId: "T-test", repository: "lox/project", targetType: "repository",
      webhookUrl: "https://hooks.example.test/updated", events: ["issues"], behavior: "investigate",
    })
    expect(updated.id).toBe(subscription.id)
    expect(database.list("T-test")).toEqual([updated])
    expect(() => database.sqlite.exec("UPDATE subscriptions SET webhook_binding = 'legacy'"))
      .toThrow("CHECK constraint failed")
    database.close()
  })
})

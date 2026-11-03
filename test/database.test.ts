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

describe("SubscriptionDatabase", () => {
  test("classifies old bindings conservatively and preserves state across migration and restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-bindings-"))
    directories.push(directory)
    const path = join(directory, "relay.sqlite")
    let database = new SubscriptionDatabase(path)
    const baseline = { id: "entry-1", fingerprint: "version-1", title: null, url: null, publishedAt: null, updatedAt: null }
    const feed = database.upsertFeed({
      threadId: "T-test", feedUrl: "https://status.example/feed", webhookUrl: "https://hooks.example.test/shared",
      behavior: "notify", etag: "etag-before", lastModified: "last-modified-before",
    }, [baseline])
    const buildkite = database.upsertBuildkite({
      threadId: "T-test", organization: "buildkite", pipeline: "amp-subscribe", branch: "Feature/CI", commit: "a".repeat(40),
      webhookUrl: feed.webhookUrl, events: ["build.finished"], behavior: "investigate", deliveryMode: "queue",
    })
    database.markBuildkiteDelivered(buildkite.id, "before-migration", "build.finished")
    // Reproduce the feed schema deployed before binding tracking existed.
    database.sqlite.exec("ALTER TABLE feed_subscriptions DROP COLUMN webhook_binding")
    database.close()
    database = new SubscriptionDatabase(path)
    expect(database.listFeeds("T-test")[0]?.webhookBinding).toBe("legacy")
    const url = "https://hooks.example.test/thread"
    expect(database.updateWebhook("T-test", url, "thread_v1")).toEqual({ feed: 1, buildkite: 1 })
    expect(database.updateWebhook("T-test", url, "thread_v1")).toEqual({ feed: 0, buildkite: 0 })
    database.close()
    database = new SubscriptionDatabase(path)
    expect(database.listFeeds("T-test")).toEqual([{ ...feed, webhookUrl: url, webhookBinding: "thread_v1" }])
    expect(database.listBuildkite("T-test")).toEqual([{ ...buildkite, webhookUrl: url, webhookBinding: "thread_v1" }])
    expect(database.wasBuildkiteDelivered(buildkite.id, "before-migration", "build.finished")).toBe(true)
    expect(database.feedEntryChanged(feed.id, baseline)).toBe(false)
    database.close()
  })

  test("does not create GitHub tables and leaves obsolete schemas and rows inert", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-retired-github-"))
    directories.push(directory)
    const path = join(directory, "relay.sqlite")
    let database = new SubscriptionDatabase(path)
    expect(database.sqlite.query("SELECT name FROM sqlite_master WHERE name IN ('subscriptions', 'deliveries')").all()).toEqual([])
    database.close()
    // An old GitHub schema must not be migrated, queried, or deleted on startup.
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, pull_request_number INTEGER, webhook_url TEXT);
      CREATE TABLE deliveries (subscription_id TEXT, delivery_id TEXT);
      INSERT INTO subscriptions VALUES ('old-sub', 17, 'https://hooks.example.test/old');
      INSERT INTO deliveries VALUES ('old-sub', 'old-delivery');
    `)
    const schema = legacy.query("SELECT name, sql FROM sqlite_master WHERE name IN ('subscriptions', 'deliveries') ORDER BY name").all()
    legacy.close()
    database = new SubscriptionDatabase(path)
    database.updateWebhook("T-test", "https://hooks.example.test/thread", "thread_v1")
    expect(database.countWebhookBindings()).toEqual([])
    expect(database.sqlite.query("SELECT name, sql FROM sqlite_master WHERE name IN ('subscriptions', 'deliveries') ORDER BY name").all()).toEqual(schema)
    expect(database.sqlite.query("SELECT * FROM subscriptions").all()).toEqual([
      { id: "old-sub", pull_request_number: 17, webhook_url: "https://hooks.example.test/old" },
    ])
    expect(database.sqlite.query("SELECT * FROM deliveries").all()).toEqual([
      { subscription_id: "old-sub", delivery_id: "old-delivery" },
    ])
    database.close()
  })

  test("stores, updates, matches, and deduplicates Buildkite subscriptions", () => {
    const database = new SubscriptionDatabase(":memory:")
    const subscription = database.upsertBuildkite({
      threadId: "T-test",
      organization: "Buildkite",
      pipeline: "Amp-Subscribe",
      webhookUrl: "https://hooks.example.test/buildkite",
      events: ["build.finished", "build.skipped"],
      behavior: "investigate",
    }, "thread_v1")
    expect(subscription).toMatchObject({
      organization: "buildkite", pipeline: "amp-subscribe", deliveryMode: "automatic", webhookBinding: "thread_v1",
    })
    expect(database.matchingBuildkite("BUILDKITE", "AMP-SUBSCRIBE", "build.finished", "main")).toEqual([subscription])
    expect(database.matchingBuildkite("buildkite", "amp-subscribe", "build.running", "main")).toEqual([])
    database.markBuildkiteDelivered(subscription.id, "delivery-1", "build.finished")
    expect(database.wasBuildkiteDelivered(subscription.id, "delivery-1", "build.finished")).toBe(true)

    const updated = database.upsertBuildkite({
      threadId: "T-test",
      organization: "buildkite",
      pipeline: "amp-subscribe",
      webhookUrl: "https://hooks.example.test/updated",
      events: ["build.finished"],
      behavior: "notify",
      deliveryMode: "queue",
    }, "thread_v1")
    expect(updated.id).toBe(subscription.id)
    expect(database.listBuildkite("T-test")).toEqual([updated])
    expect(database.countBuildkiteSubscriptions()).toBe(1)
    expect(database.deleteBuildkite("T-other", updated.id)).toBe(false)
    expect(database.deleteBuildkite("T-test", updated.id)).toBe(true)
    database.close()
  })

  test("migrates Buildkite filters without losing subscriptions or deliveries and persists filter updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-buildkite-filters-"))
    directories.push(directory)
    const path = join(directory, "relay.sqlite")
    let database = new SubscriptionDatabase(path)
    const input = {
      threadId: "T-test", organization: "buildkite", pipeline: "amp-subscribe",
      webhookUrl: "https://hooks.example.test/buildkite", events: ["build.finished"] as const,
      behavior: "investigate" as const,
    }
    const subscription = database.upsertBuildkite({ ...input, events: [...input.events] }, "thread_v1")
    database.markBuildkiteDelivered(subscription.id, "before-migration", "build.finished")
    database.sqlite.exec("ALTER TABLE buildkite_subscriptions DROP COLUMN branch; ALTER TABLE buildkite_subscriptions DROP COLUMN commit_sha")
    database.close()

    database = new SubscriptionDatabase(path)
    expect(database.listBuildkite("T-test")).toEqual([subscription])
    expect(database.matchingBuildkite("buildkite", "amp-subscribe", "build.finished", "other-branch")).toEqual([subscription])
    const filtered = database.upsertBuildkite({
      ...input, events: [...input.events], branch: "Feature/CI", commit: "A".repeat(40),
    }, "thread_v1")
    expect(filtered).toMatchObject({ id: subscription.id, branch: "Feature/CI", commit: "a".repeat(40) })
    database.close()

    database = new SubscriptionDatabase(path)
    expect(database.listBuildkite("T-test")).toEqual([filtered])
    expect(database.wasBuildkiteDelivered(subscription.id, "before-migration", "build.finished")).toBe(true)
    const nextHead = database.upsertBuildkite({
      ...input, events: [...input.events], branch: "Feature/CI", commit: "b".repeat(40),
    }, "thread_v1")
    expect(nextHead.id).toBe(subscription.id)
    expect(database.matchingBuildkite("buildkite", "amp-subscribe", "build.finished", "Feature/CI", "a".repeat(40))).toEqual([])
    expect(database.matchingBuildkite("buildkite", "amp-subscribe", "build.finished", "Feature/CI", "b".repeat(40))).toEqual([nextHead])
    expect(database.countBuildkiteSubscriptions()).toBe(1)
    const unfiltered = database.upsertBuildkite({ ...input, events: [...input.events] }, "thread_v1")
    expect(unfiltered).toEqual(subscription)
    expect(database.listBuildkite("T-test")).toEqual([unfiltered])
    expect(database.matchingBuildkite("buildkite", "amp-subscribe", "build.finished", "any-branch")).toEqual([unfiltered])
    database.close()
  })
})

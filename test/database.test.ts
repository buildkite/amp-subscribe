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
  test("migrates existing pull request subscriptions and deliveries", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-subscribe-"))
    directories.push(directory)
    const path = join(directory, "relay.sqlite")
    const legacy = new Database(path, { create: true })
    legacy.exec(`
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        webhook_url TEXT NOT NULL,
        events TEXT NOT NULL,
        behavior TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, repository, pull_request_number)
      );
      CREATE TABLE deliveries (
        subscription_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id, delivery_id, event),
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );
      INSERT INTO subscriptions VALUES
        ('sub-1', 'T-test', 'lox/project', 17, 'https://hooks.example.test/secret',
          '["reviews"]', 'investigate', '2026-08-23T00:00:00.000Z');
      INSERT INTO deliveries VALUES ('sub-1', 'delivery-1', 'reviews', '2026-08-23T00:01:00.000Z');
    `)
    legacy.close()

    const database = new SubscriptionDatabase(path)
    expect(database.list("T-test")).toEqual([{
      id: "sub-1",
      threadId: "T-test",
      repository: "lox/project",
      targetType: "pull_request",
      pullRequestNumber: 17,
      webhookUrl: "https://hooks.example.test/secret",
      events: ["reviews"],
      behavior: "investigate",
      createdAt: "2026-08-23T00:00:00.000Z",
    }])
    expect(database.wasDelivered("sub-1", "delivery-1", "reviews")).toBe(true)
    database.close()
  })

  test("supports rollback writes and adopts them after rolling forward", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-subscribe-"))
    directories.push(directory)
    const path = join(directory, "relay.sqlite")
    const database = new SubscriptionDatabase(path)
    database.upsert({
      threadId: "T-test",
      repository: "lox/project",
      targetType: "branch",
      branch: "main",
      webhookUrl: "https://hooks.example.test/branch",
      events: ["commits"],
      behavior: "notify",
    })
    database.close()

    const rollback = new Database(path)
    expect(rollback.query<{ pull_request_number: number | null }, []>(`
      SELECT pull_request_number FROM subscriptions WHERE target_type = 'branch'
    `).get()?.pull_request_number).toBeNull()
    rollback.query(`
      INSERT INTO subscriptions
        (id, thread_id, repository, pull_request_number, webhook_url, events, behavior, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, repository, pull_request_number) DO UPDATE SET
        webhook_url = excluded.webhook_url, events = excluded.events, behavior = excluded.behavior
    `).run(
      "legacy-sub",
      "T-test",
      "lox/project",
      18,
      "https://hooks.example.test/legacy",
      '["reviews"]',
      "investigate",
      "2026-08-23T00:00:00.000Z",
    )
    rollback.close()

    const rolledForward = new SubscriptionDatabase(path)
    expect(rolledForward.matching("lox/project", "pull_request", "18", "reviews"))
      .toHaveLength(1)
    rolledForward.upsert({
      threadId: "T-test",
      repository: "lox/project",
      targetType: "pull_request",
      pullRequestNumber: 19,
      webhookUrl: "https://hooks.example.test/current",
      events: ["reviews"],
      behavior: "investigate",
    })
    expect(rolledForward.countSubscriptionsByTargetType()).toContainEqual({
      targetType: "pull_request",
      count: 2,
    })
    const adopted = rolledForward.upsert({
      threadId: "T-test",
      repository: "lox/project",
      targetType: "pull_request",
      pullRequestNumber: 18,
      webhookUrl: "https://hooks.example.test/current",
      events: ["reviews"],
      behavior: "investigate",
    })
    expect(adopted.id).toBe("legacy-sub")
    expect(rolledForward.list("T-test")).toContainEqual(adopted)
    rolledForward.close()
  })

  test("migrates the branch-capable schema to support repository targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-subscribe-"))
    directories.push(directory)
    const path = join(directory, "relay.sqlite")
    const previous = new Database(path, { create: true })
    previous.exec(`
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pull_request_number INTEGER,
        target_type TEXT CHECK(target_type IN ('pull_request', 'branch')),
        target TEXT,
        webhook_url TEXT NOT NULL,
        events TEXT NOT NULL,
        behavior TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, repository, target_type, target),
        UNIQUE(thread_id, repository, pull_request_number)
      );
      CREATE TABLE deliveries (
        subscription_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id, delivery_id, event),
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );
      INSERT INTO subscriptions VALUES
        ('sub-branch', 'T-test', 'lox/project', NULL, 'branch', 'main',
          'https://hooks.example.test/branch', '["commits"]', 'notify', '2026-08-23T00:00:00.000Z');
      INSERT INTO deliveries VALUES
        ('sub-branch', 'delivery-branch', 'commits', '2026-08-23T00:01:00.000Z');
    `)
    previous.close()

    const database = new SubscriptionDatabase(path)
    expect(database.list("T-test")).toEqual([expect.objectContaining({
      id: "sub-branch",
      targetType: "branch",
      branch: "main",
    })])
    expect(database.wasDelivered("sub-branch", "delivery-branch", "commits")).toBe(true)
    expect(database.upsert({
      threadId: "T-test",
      repository: "lox/project",
      targetType: "repository",
      webhookUrl: "https://hooks.example.test/repository",
      events: ["issues"],
      behavior: "notify",
    })).toMatchObject({ targetType: "repository", repository: "lox/project" })
    database.close()
  })

  test("stores and matches one repository subscription per thread and repository", () => {
    const database = new SubscriptionDatabase(":memory:")
    const subscription = database.upsert({
      threadId: "T-test",
      repository: "lox/project",
      targetType: "repository",
      webhookUrl: "https://hooks.example.test/repository",
      events: ["pull_requests", "issues"],
      behavior: "notify",
    })
    expect(database.list("T-test")).toEqual([subscription])
    expect(database.matching("LOX/PROJECT", "repository", "*", "issues")).toEqual([subscription])
    expect(database.matching("lox/project", "repository", "*", "reviews")).toEqual([])

    const updated = database.upsert({
      threadId: "T-test",
      repository: "lox/project",
      targetType: "repository",
      webhookUrl: "https://hooks.example.test/updated",
      events: ["issues"],
      behavior: "investigate",
    })
    expect(updated.id).toBe(subscription.id)
    expect(database.list("T-test")).toEqual([updated])
    database.close()
  })
})

import { Database } from "bun:sqlite"
import type { FeedEntry, FeedSubscription, Subscription, SubscriptionBehavior, SubscriptionEvent, WebhookBinding } from "./types"

type WithoutStoredFields<T> = T extends unknown ? Omit<T, "id" | "createdAt" | "webhookBinding"> : never
type SubscriptionInput = WithoutStoredFields<Subscription>

interface SubscriptionRow {
  id: string
  thread_id: string
  repository: string
  target_type: "pull_request" | "branch" | "repository"
  target: string
  webhook_url: string
  webhook_binding: WebhookBinding
  events: string
  behavior: SubscriptionBehavior
  created_at: string
}

interface FeedSubscriptionRow {
  id: string
  thread_id: string
  feed_url: string
  webhook_url: string
  webhook_binding: WebhookBinding
  behavior: SubscriptionBehavior
  etag: string | null
  last_modified: string | null
  created_at: string
}

function mapFeedSubscription(row: FeedSubscriptionRow): FeedSubscription {
  return {
    id: row.id,
    threadId: row.thread_id,
    feedUrl: row.feed_url,
    webhookUrl: row.webhook_url,
    webhookBinding: row.webhook_binding,
    behavior: row.behavior,
    etag: row.etag,
    lastModified: row.last_modified,
    createdAt: row.created_at,
  }
}

function mapSubscription(row: SubscriptionRow): Subscription {
  const common = {
    id: row.id,
    threadId: row.thread_id,
    repository: row.repository,
    webhookUrl: row.webhook_url,
    webhookBinding: row.webhook_binding,
    events: JSON.parse(row.events) as SubscriptionEvent[],
    behavior: row.behavior,
    createdAt: row.created_at,
  }
  if (row.target_type === "branch") {
    return { ...common, targetType: "branch", branch: row.target }
  }
  if (row.target_type === "repository") return { ...common, targetType: "repository" }
  return { ...common, targetType: "pull_request", pullRequestNumber: Number(row.target) }
}

export class SubscriptionDatabase {
  readonly sqlite: Database

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true })
    this.sqlite.exec("PRAGMA journal_mode = WAL")
    this.sqlite.exec("PRAGMA foreign_keys = ON")
    // Fail closed rather than deliver to or silently reclassify an old endpoint.
    // Upgrade older databases through the binding-tracking release first.
    for (const table of ["subscriptions", "feed_subscriptions"]) {
      const columns = this.sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
      if (columns.length === 0) continue
      if (!columns.some((column) => column.name === "webhook_binding")
        || this.sqlite.query(`SELECT 1 FROM ${table} WHERE webhook_binding IS NOT 'thread_v1' LIMIT 1`).get()
        || (table === "subscriptions" && (!columns.some((column) => column.name === "target_type")
          || this.sqlite.query("SELECT 1 FROM subscriptions WHERE target_type IS NULL OR target IS NULL LIMIT 1").get()))) {
        this.sqlite.close()
        throw new Error("Unsupported subscription database: finish thread_v1 migration with the previous bridge before upgrading")
      }
    }
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('pull_request', 'branch', 'repository')),
        target TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        webhook_binding TEXT NOT NULL CHECK(webhook_binding = 'thread_v1'),
        events TEXT NOT NULL,
        behavior TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, repository, target_type, target)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id, delivery_id, event),
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS feed_subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        webhook_binding TEXT NOT NULL CHECK(webhook_binding = 'thread_v1'),
        behavior TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, feed_url)
      );
      CREATE TABLE IF NOT EXISTS feed_entries (
        subscription_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id, entry_id),
        FOREIGN KEY(subscription_id) REFERENCES feed_subscriptions(id) ON DELETE CASCADE
      );
    `)
  }

  upsert(input: SubscriptionInput): Subscription {
    const target = input.targetType === "pull_request" ? String(input.pullRequestNumber)
      : input.targetType === "branch" ? input.branch
        : "*"
    const existing = this.sqlite.query<SubscriptionRow, [string, string, string, string]>(`
      SELECT * FROM subscriptions
      WHERE thread_id = ? AND repository = ? AND target_type = ? AND target = ?
    `).get(input.threadId, input.repository, input.targetType, target)
    const stored = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.created_at ?? new Date().toISOString(),
    }
    const subscription: Subscription = { ...input, ...stored, webhookBinding: "thread_v1" }
    if (existing) {
      this.sqlite.query(`
        UPDATE subscriptions SET
          webhook_url = ?, events = ?, behavior = ?
        WHERE id = ?
      `).run(
        subscription.webhookUrl,
        JSON.stringify(subscription.events),
        subscription.behavior,
        subscription.id,
      )
    } else {
      this.sqlite.query(`
        INSERT INTO subscriptions
          (id, thread_id, repository, target_type, target,
            webhook_url, events, behavior, created_at, webhook_binding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'thread_v1')
      `).run(
        subscription.id,
        subscription.threadId,
        subscription.repository,
        subscription.targetType,
        target,
        subscription.webhookUrl,
        JSON.stringify(subscription.events),
        subscription.behavior,
        subscription.createdAt,
      )
    }
    return subscription
  }

  countSubscriptionsByTargetType(): Array<{ targetType: string; count: number }> {
    return this.sqlite.query<{ target_type: string; count: number }, []>(`
      SELECT target_type, COUNT(*) AS count FROM subscriptions GROUP BY target_type
    `).all().map((row) => ({ targetType: row.target_type, count: row.count }))
  }

  countFeedSubscriptions(): number {
    return this.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM feed_subscriptions",
    ).get()?.count ?? 0
  }

  list(threadId: string): Subscription[] {
    return this.sqlite.query<SubscriptionRow, [string]>(
      "SELECT * FROM subscriptions WHERE thread_id = ? ORDER BY created_at",
    ).all(threadId).map(mapSubscription)
  }

  updateWebhook(threadId: string, webhookUrl: string) {
    return this.sqlite.transaction(() => {
      const github = this.sqlite.query(`UPDATE subscriptions SET webhook_url = ?
        WHERE thread_id = ? AND webhook_url != ?`)
        .run(webhookUrl, threadId, webhookUrl).changes
      const feed = this.sqlite.query(`UPDATE feed_subscriptions SET webhook_url = ?
        WHERE thread_id = ? AND webhook_url != ?`)
        .run(webhookUrl, threadId, webhookUrl).changes
      return { github, feed }
    })()
  }

  countWebhookBindings() {
    return this.sqlite.query<{ source: string; binding: string; count: number }, []>(`
      SELECT 'github' AS source, webhook_binding AS binding, COUNT(*) AS count
      FROM subscriptions GROUP BY webhook_binding
      UNION ALL
      SELECT 'feed', webhook_binding, COUNT(*) FROM feed_subscriptions GROUP BY webhook_binding
    `).all()
  }

  matching(repository: string, targetType: Subscription["targetType"], target: string, event: SubscriptionEvent): Subscription[] {
    return this.sqlite.query<SubscriptionRow, [string, string, string]>(`
      SELECT * FROM subscriptions WHERE repository = ? AND target_type = ? AND target = ?
    `).all(repository.toLowerCase(), targetType, target).map(mapSubscription)
      .filter((subscription) => subscription.events.includes(event))
  }

  delete(threadId: string, id: string, webhookUrl: string | null = null): boolean {
    return this.sqlite.query(`
      DELETE FROM subscriptions WHERE id = ? AND thread_id = ? AND (? IS NULL OR webhook_url = ?)
    `).run(id, threadId, webhookUrl, webhookUrl).changes > 0
  }

  wasDelivered(subscriptionId: string, deliveryId: string, event: string): boolean {
    return this.sqlite.query(`
      SELECT 1 FROM deliveries WHERE subscription_id = ? AND delivery_id = ? AND event = ?
    `).get(subscriptionId, deliveryId, event) !== null
  }

  markDelivered(subscriptionId: string, deliveryId: string, event: string): void {
    this.sqlite.query(`
      INSERT OR IGNORE INTO deliveries (subscription_id, delivery_id, event, delivered_at)
      VALUES (?, ?, ?, ?)
    `).run(subscriptionId, deliveryId, event, new Date().toISOString())
  }

  upsertFeed(input: WithoutStoredFields<FeedSubscription>, baseline: FeedEntry[]): FeedSubscription {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<FeedSubscriptionRow, [string, string]>(`
        SELECT * FROM feed_subscriptions WHERE thread_id = ? AND feed_url = ?
      `).get(input.threadId, input.feedUrl)
      const subscription: FeedSubscription = {
        ...input,
        webhookBinding: "thread_v1",
        id: existing?.id ?? crypto.randomUUID(),
        etag: existing?.etag ?? input.etag,
        lastModified: existing?.last_modified ?? input.lastModified,
        createdAt: existing?.created_at ?? new Date().toISOString(),
      }
      if (existing) {
        this.sqlite.query(`
          UPDATE feed_subscriptions
          SET webhook_url = ?, behavior = ?
          WHERE id = ?
        `).run(input.webhookUrl, input.behavior, existing.id)
      } else {
        this.sqlite.query(`
          INSERT INTO feed_subscriptions
            (id, thread_id, feed_url, webhook_url, behavior, etag, last_modified, created_at, webhook_binding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'thread_v1')
        `).run(
          subscription.id,
          subscription.threadId,
          subscription.feedUrl,
          subscription.webhookUrl,
          subscription.behavior,
          subscription.etag,
          subscription.lastModified,
          subscription.createdAt,
        )
        for (const entry of baseline) this.storeFeedEntry(subscription.id, entry)
      }
      return subscription
    })()
  }

  listFeeds(threadId: string): FeedSubscription[] {
    return this.sqlite.query<FeedSubscriptionRow, [string]>(`
      SELECT * FROM feed_subscriptions WHERE thread_id = ? ORDER BY created_at
    `).all(threadId).map(mapFeedSubscription)
  }

  allFeeds(): FeedSubscription[] {
    return this.sqlite.query<FeedSubscriptionRow, []>("SELECT * FROM feed_subscriptions ORDER BY created_at")
      .all().map(mapFeedSubscription)
  }

  updateFeedCache(id: string, etag: string | null, lastModified: string | null): void {
    this.sqlite.query("UPDATE feed_subscriptions SET etag = ?, last_modified = ? WHERE id = ?")
      .run(etag, lastModified, id)
  }

  feedEntryChanged(subscriptionId: string, entry: FeedEntry): boolean {
    const existing = this.sqlite.query<{ fingerprint: string }, [string, string]>(`
      SELECT fingerprint FROM feed_entries WHERE subscription_id = ? AND entry_id = ?
    `).get(subscriptionId, entry.id)
    return !existing || existing.fingerprint !== entry.fingerprint
  }

  storeFeedEntry(subscriptionId: string, entry: FeedEntry): void {
    this.sqlite.query(`
      INSERT INTO feed_entries (subscription_id, entry_id, fingerprint, seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subscription_id, entry_id) DO UPDATE SET
        fingerprint = excluded.fingerprint, seen_at = excluded.seen_at
    `).run(subscriptionId, entry.id, entry.fingerprint, new Date().toISOString())
  }

  deleteFeed(threadId: string, id: string, webhookUrl: string | null = null): boolean {
    return this.sqlite.query(`
      DELETE FROM feed_subscriptions WHERE id = ? AND thread_id = ? AND (? IS NULL OR webhook_url = ?)
    `).run(id, threadId, webhookUrl, webhookUrl).changes > 0
  }

  close(): void {
    this.sqlite.close()
  }
}

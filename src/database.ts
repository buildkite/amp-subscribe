import { Database } from "bun:sqlite"
import type {
  BuildkiteEvent,
  BuildkiteSubscription,
  FeedEntry,
  FeedSubscription,
  SubscriptionBehavior,
  SubscriptionDeliveryMode,
  WebhookBinding,
} from "./types"

type WithoutStoredFields<T> = T extends unknown ? Omit<T, "id" | "createdAt" | "webhookBinding"> : never
type WithOptionalDeliveryMode<T> = T extends unknown
  ? Omit<T, "deliveryMode"> & { deliveryMode?: SubscriptionDeliveryMode }
  : never
type BuildkiteSubscriptionInput = WithOptionalDeliveryMode<WithoutStoredFields<BuildkiteSubscription>>

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

interface BuildkiteSubscriptionRow {
  id: string
  thread_id: string
  organization: string
  pipeline: string
  branch: string | null
  commit_sha: string | null
  webhook_url: string
  webhook_binding: WebhookBinding
  events: string
  behavior: SubscriptionBehavior
  delivery_mode: SubscriptionDeliveryMode
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

function mapBuildkiteSubscription(row: BuildkiteSubscriptionRow): BuildkiteSubscription {
  return {
    id: row.id,
    threadId: row.thread_id,
    organization: row.organization,
    pipeline: row.pipeline,
    ...(row.branch !== null ? { branch: row.branch } : {}),
    ...(row.commit_sha !== null ? { commit: row.commit_sha } : {}),
    webhookUrl: row.webhook_url,
    webhookBinding: row.webhook_binding,
    events: JSON.parse(row.events) as BuildkiteEvent[],
    behavior: row.behavior,
    deliveryMode: row.delivery_mode,
    createdAt: row.created_at,
  }
}

export class SubscriptionDatabase {
  readonly sqlite: Database

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true })
    this.sqlite.exec("PRAGMA journal_mode = WAL")
    this.sqlite.exec("PRAGMA foreign_keys = ON")
    // Obsolete GitHub tables, if present, are intentionally left untouched.
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS feed_subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS buildkite_subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        organization TEXT NOT NULL,
        pipeline TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        webhook_binding TEXT NOT NULL DEFAULT 'legacy'
          CHECK(webhook_binding IN ('legacy', 'thread_v1')),
        events TEXT NOT NULL,
        behavior TEXT NOT NULL,
        delivery_mode TEXT NOT NULL DEFAULT 'automatic'
          CHECK(delivery_mode IN ('automatic', 'queue', 'steer')),
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, organization, pipeline)
      );
      CREATE INDEX IF NOT EXISTS buildkite_subscriptions_target
        ON buildkite_subscriptions(organization, pipeline);
      CREATE TABLE IF NOT EXISTS buildkite_deliveries (
        subscription_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id, delivery_id, event),
        FOREIGN KEY(subscription_id) REFERENCES buildkite_subscriptions(id) ON DELETE CASCADE
      );
    `)
    // Existing endpoints are unclassified until an updated plugin registers them.
    const feedColumns = this.sqlite.query<{ name: string }, []>("PRAGMA table_info(feed_subscriptions)").all()
    if (!feedColumns.some((column) => column.name === "webhook_binding")) {
      this.sqlite.exec(`ALTER TABLE feed_subscriptions ADD COLUMN webhook_binding TEXT NOT NULL
        DEFAULT 'legacy' CHECK(webhook_binding IN ('legacy', 'thread_v1'))`)
    }
    const buildkiteColumns = this.sqlite.query<{ name: string }, []>("PRAGMA table_info(buildkite_subscriptions)").all()
    for (const column of ["branch", "commit_sha"]) {
      if (!buildkiteColumns.some((item) => item.name === column)) {
        this.sqlite.exec(`ALTER TABLE buildkite_subscriptions ADD COLUMN ${column} TEXT`)
      }
    }
  }

  countFeedSubscriptions(): number {
    return this.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM feed_subscriptions",
    ).get()?.count ?? 0
  }

  countBuildkiteSubscriptions(): number {
    return this.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM buildkite_subscriptions",
    ).get()?.count ?? 0
  }

  updateWebhook(threadId: string, webhookUrl: string, webhookBinding: WebhookBinding = "legacy") {
    return this.sqlite.transaction(() => {
      const feed = this.sqlite.query(`UPDATE feed_subscriptions SET webhook_url = ?, webhook_binding = ?
        WHERE thread_id = ? AND (webhook_url != ? OR webhook_binding != ?)`)
        .run(webhookUrl, webhookBinding, threadId, webhookUrl, webhookBinding).changes
      const buildkite = this.sqlite.query(`UPDATE buildkite_subscriptions SET webhook_url = ?, webhook_binding = ?
        WHERE thread_id = ? AND (webhook_url != ? OR webhook_binding != ?)`)
        .run(webhookUrl, webhookBinding, threadId, webhookUrl, webhookBinding).changes
      return { feed, buildkite }
    })()
  }

  countWebhookBindings() {
    return this.sqlite.query<{ source: string; binding: WebhookBinding; count: number }, []>(`
      SELECT 'feed' AS source, webhook_binding AS binding, COUNT(*) AS count
      FROM feed_subscriptions GROUP BY webhook_binding
      UNION ALL
      SELECT 'buildkite', webhook_binding, COUNT(*) FROM buildkite_subscriptions GROUP BY webhook_binding
    `).all()
  }

  upsertBuildkite(
    input: BuildkiteSubscriptionInput,
    webhookBinding: WebhookBinding = "legacy",
  ): BuildkiteSubscription {
    const organization = input.organization.toLowerCase()
    const pipeline = input.pipeline.toLowerCase()
    const existing = this.sqlite.query<BuildkiteSubscriptionRow, [string, string, string]>(`
      SELECT * FROM buildkite_subscriptions WHERE thread_id = ? AND organization = ? AND pipeline = ?
    `).get(input.threadId, organization, pipeline)
    const subscription: BuildkiteSubscription = {
      ...input,
      organization,
      pipeline,
      ...(input.commit !== undefined ? { commit: input.commit.toLowerCase() } : {}),
      deliveryMode: input.deliveryMode ?? existing?.delivery_mode ?? "automatic",
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.created_at ?? new Date().toISOString(),
      webhookBinding,
    }
    this.sqlite.query(`
      INSERT INTO buildkite_subscriptions
        (id, thread_id, organization, pipeline, branch, commit_sha, webhook_url, webhook_binding, events, behavior, delivery_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, organization, pipeline) DO UPDATE SET
        branch = excluded.branch,
        commit_sha = excluded.commit_sha,
        webhook_url = excluded.webhook_url,
        webhook_binding = excluded.webhook_binding,
        events = excluded.events,
        behavior = excluded.behavior,
        delivery_mode = excluded.delivery_mode
    `).run(
      subscription.id,
      subscription.threadId,
      subscription.organization,
      subscription.pipeline,
      subscription.branch ?? null,
      subscription.commit ?? null,
      subscription.webhookUrl,
      subscription.webhookBinding,
      JSON.stringify(subscription.events),
      subscription.behavior,
      subscription.deliveryMode,
      subscription.createdAt,
    )
    return subscription
  }

  listBuildkite(threadId: string): BuildkiteSubscription[] {
    return this.sqlite.query<BuildkiteSubscriptionRow, [string]>(`
      SELECT * FROM buildkite_subscriptions WHERE thread_id = ? ORDER BY created_at
    `).all(threadId).map(mapBuildkiteSubscription)
  }

  matchingBuildkite(organization: string, pipeline: string, event: BuildkiteEvent, branch: string, commit?: string): BuildkiteSubscription[] {
    return this.sqlite.query<BuildkiteSubscriptionRow, [string, string]>(`
      SELECT * FROM buildkite_subscriptions WHERE organization = ? AND pipeline = ?
    `).all(organization.toLowerCase(), pipeline.toLowerCase()).map(mapBuildkiteSubscription)
      .filter((subscription) => subscription.events.includes(event)
        && (subscription.branch === undefined || subscription.branch === branch)
        && (subscription.commit === undefined || subscription.commit === commit?.toLowerCase()))
  }

  deleteBuildkite(threadId: string, id: string, webhookUrl: string | null = null): boolean {
    return this.sqlite.query(`
      DELETE FROM buildkite_subscriptions WHERE id = ? AND thread_id = ? AND (? IS NULL OR webhook_url = ?)
    `).run(id, threadId, webhookUrl, webhookUrl).changes > 0
  }

  wasBuildkiteDelivered(subscriptionId: string, deliveryId: string, event: string): boolean {
    return this.sqlite.query(`
      SELECT 1 FROM buildkite_deliveries WHERE subscription_id = ? AND delivery_id = ? AND event = ?
    `).get(subscriptionId, deliveryId, event) !== null
  }

  markBuildkiteDelivered(subscriptionId: string, deliveryId: string, event: string): void {
    this.sqlite.query(`
      INSERT OR IGNORE INTO buildkite_deliveries (subscription_id, delivery_id, event, delivered_at)
      VALUES (?, ?, ?, ?)
    `).run(subscriptionId, deliveryId, event, new Date().toISOString())
  }

  upsertFeed(input: WithoutStoredFields<FeedSubscription>, baseline: FeedEntry[], webhookBinding: WebhookBinding = "legacy"): FeedSubscription {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<FeedSubscriptionRow, [string, string]>(`
        SELECT * FROM feed_subscriptions WHERE thread_id = ? AND feed_url = ?
      `).get(input.threadId, input.feedUrl)
      const subscription: FeedSubscription = {
        ...input,
        webhookBinding,
        id: existing?.id ?? crypto.randomUUID(),
        etag: existing?.etag ?? input.etag,
        lastModified: existing?.last_modified ?? input.lastModified,
        createdAt: existing?.created_at ?? new Date().toISOString(),
      }
      if (existing) {
        this.sqlite.query(`
          UPDATE feed_subscriptions
          SET webhook_url = ?, behavior = ?, webhook_binding = ?
          WHERE id = ?
        `).run(input.webhookUrl, input.behavior, webhookBinding, existing.id)
      } else {
        this.sqlite.query(`
          INSERT INTO feed_subscriptions
            (id, thread_id, feed_url, webhook_url, behavior, etag, last_modified, created_at, webhook_binding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          subscription.id,
          subscription.threadId,
          subscription.feedUrl,
          subscription.webhookUrl,
          subscription.behavior,
          subscription.etag,
          subscription.lastModified,
          subscription.createdAt,
          webhookBinding,
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

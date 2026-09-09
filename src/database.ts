import { Database } from "bun:sqlite"
import type { FeedEntry, FeedSubscription, Subscription, SubscriptionBehavior, SubscriptionEvent } from "./types"

type WithoutStoredFields<T> = T extends unknown ? Omit<T, "id" | "createdAt"> : never
type SubscriptionInput = WithoutStoredFields<Subscription>

interface SubscriptionRow {
  id: string
  thread_id: string
  repository: string
  pull_request_number: number | null
  target_type: "pull_request" | "branch" | "repository" | null
  target: string | null
  webhook_url: string
  events: string
  behavior: SubscriptionBehavior
  created_at: string
}

interface FeedSubscriptionRow {
  id: string
  thread_id: string
  feed_url: string
  webhook_url: string
  behavior: SubscriptionBehavior
  etag: string | null
  last_modified: string | null
  created_at: string
}

interface PendingGitHubDelivery {
  id: number
  subscription_id: string
  delivery_id: string
  event: string
  body: string
  idempotency_key: string
  attempts: number
  webhook_url: string
  thread_id: string
}

function mapFeedSubscription(row: FeedSubscriptionRow): FeedSubscription {
  return {
    id: row.id,
    threadId: row.thread_id,
    feedUrl: row.feed_url,
    webhookUrl: row.webhook_url,
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
    events: JSON.parse(row.events) as SubscriptionEvent[],
    behavior: row.behavior,
    createdAt: row.created_at,
  }
  if (row.target_type === "branch" && row.target) {
    return { ...common, targetType: "branch", branch: row.target }
  }
  if (row.target_type === "repository") return { ...common, targetType: "repository" }
  return { ...common, targetType: "pull_request", pullRequestNumber: row.pull_request_number ?? Number(row.target) }
}

export class SubscriptionDatabase {
  readonly sqlite: Database

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true })
    this.sqlite.exec("PRAGMA journal_mode = WAL")
    this.sqlite.exec("PRAGMA foreign_keys = ON")
    const columns = this.sqlite.query<{ name: string }, []>("PRAGMA table_info(subscriptions)").all()
    const legacy = columns.some((column) => column.name === "pull_request_number")
      && !columns.some((column) => column.name === "target_type")
    if (legacy) this.migratePullRequestSubscriptions()
    const schema = this.sqlite.query<{ sql: string }, []>(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'
    `).get()?.sql
    if (schema && !schema.includes("'repository'")) this.migrateRepositorySubscriptions()
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pull_request_number INTEGER,
        target_type TEXT CHECK(target_type IN ('pull_request', 'branch', 'repository')),
        target TEXT,
        webhook_url TEXT NOT NULL,
        events TEXT NOT NULL,
        behavior TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, repository, target_type, target),
        UNIQUE(thread_id, repository, pull_request_number)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id, delivery_id, event),
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS pending_github_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        body TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_http_status INTEGER,
        UNIQUE(subscription_id, delivery_id, event)
      );
      CREATE INDEX IF NOT EXISTS pending_github_subscription_order
        ON pending_github_deliveries(subscription_id, id);
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
    `)
  }

  private migratePullRequestSubscriptions(): void {
    this.sqlite.exec("PRAGMA foreign_keys = OFF")
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        ALTER TABLE deliveries RENAME TO deliveries_legacy;
        ALTER TABLE subscriptions RENAME TO subscriptions_legacy;
        CREATE TABLE subscriptions (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          repository TEXT NOT NULL,
          pull_request_number INTEGER,
          target_type TEXT CHECK(target_type IN ('pull_request', 'branch', 'repository')),
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
        INSERT INTO subscriptions
          (id, thread_id, repository, pull_request_number, target_type, target,
            webhook_url, events, behavior, created_at)
        SELECT id, thread_id, repository, pull_request_number, 'pull_request', CAST(pull_request_number AS TEXT),
          webhook_url, events, behavior, created_at
        FROM subscriptions_legacy;
        INSERT INTO deliveries SELECT * FROM deliveries_legacy;
        DROP TABLE deliveries_legacy;
        DROP TABLE subscriptions_legacy;
      `)
    })()
    this.sqlite.exec("PRAGMA foreign_keys = ON")
  }

  private migrateRepositorySubscriptions(): void {
    this.sqlite.exec("PRAGMA foreign_keys = OFF")
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        ALTER TABLE deliveries RENAME TO deliveries_before_repository_targets;
        ALTER TABLE subscriptions RENAME TO subscriptions_before_repository_targets;
        CREATE TABLE subscriptions (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          repository TEXT NOT NULL,
          pull_request_number INTEGER,
          target_type TEXT CHECK(target_type IN ('pull_request', 'branch', 'repository')),
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
        INSERT INTO subscriptions SELECT * FROM subscriptions_before_repository_targets;
        INSERT INTO deliveries SELECT * FROM deliveries_before_repository_targets;
        DROP TABLE deliveries_before_repository_targets;
        DROP TABLE subscriptions_before_repository_targets;
      `)
    })()
    this.sqlite.exec("PRAGMA foreign_keys = ON")
  }

  upsert(input: SubscriptionInput): Subscription {
    const target = input.targetType === "pull_request" ? String(input.pullRequestNumber)
      : input.targetType === "branch" ? input.branch
        : "*"
    const pullRequestNumber = input.targetType === "pull_request" ? input.pullRequestNumber : null
    const existing = this.sqlite.query<SubscriptionRow, [string, string, string, string, string, string]>(`
      SELECT * FROM subscriptions
      WHERE thread_id = ? AND repository = ?
        AND ((target_type = ? AND target = ?)
          OR (? = 'pull_request' AND target_type IS NULL AND pull_request_number = CAST(? AS INTEGER)))
    `).get(input.threadId, input.repository, input.targetType, target, input.targetType, target)
    const stored = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.created_at ?? new Date().toISOString(),
    }
    const subscription: Subscription = { ...input, ...stored }
    if (existing) {
      this.sqlite.query(`
        UPDATE subscriptions SET
          target_type = ?, target = ?, pull_request_number = ?, webhook_url = ?, events = ?, behavior = ?
        WHERE id = ?
      `).run(
        subscription.targetType,
        target,
        pullRequestNumber,
        subscription.webhookUrl,
        JSON.stringify(subscription.events),
        subscription.behavior,
        subscription.id,
      )
      if (existing.webhook_url !== subscription.webhookUrl) {
        this.sqlite.query("UPDATE pending_github_deliveries SET next_attempt_at = 0 WHERE subscription_id = ?")
          .run(subscription.id)
      }
    } else {
      this.sqlite.query(`
        INSERT INTO subscriptions
          (id, thread_id, repository, pull_request_number, target_type, target,
            webhook_url, events, behavior, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        subscription.id,
        subscription.threadId,
        subscription.repository,
        pullRequestNumber,
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
      SELECT COALESCE(target_type, 'pull_request') AS target_type, COUNT(*) AS count
      FROM subscriptions GROUP BY COALESCE(target_type, 'pull_request')
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

  matching(repository: string, targetType: Subscription["targetType"], target: string, event: SubscriptionEvent): Subscription[] {
    return this.sqlite.query<SubscriptionRow, [string, string, string, string, string]>(`
      SELECT * FROM subscriptions WHERE repository = ?
        AND ((target_type = ? AND target = ?)
          OR (? = 'pull_request' AND target_type IS NULL AND pull_request_number = CAST(? AS INTEGER)))
    `).all(repository.toLowerCase(), targetType, target, targetType, target).map(mapSubscription)
      .filter((subscription) => subscription.events.includes(event))
  }

  delete(threadId: string, id: string): boolean {
    return this.sqlite.query("DELETE FROM subscriptions WHERE id = ? AND thread_id = ?").run(id, threadId).changes > 0
  }

  wasDelivered(subscriptionId: string, deliveryId: string, event: string): boolean {
    return this.sqlite.query(`
      SELECT 1 FROM deliveries WHERE subscription_id = ? AND delivery_id = ? AND event = ?
    `).get(subscriptionId, deliveryId, event) !== null
  }

  enqueueGitHubDelivery(subscriptionId: string, deliveryId: string, event: string, body: string, key: string): number {
    if (this.wasDelivered(subscriptionId, deliveryId, event)) return 0
    return this.sqlite.query(`
      INSERT OR IGNORE INTO pending_github_deliveries
        (subscription_id, delivery_id, event, body, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(subscriptionId, deliveryId, event, body, key, new Date().toISOString()).changes
  }

  nextGitHubDelivery(now: number): PendingGitHubDelivery | null {
    // FIFO per subscription: a failed push must not be overtaken by later pushes.
    // Other subscriptions can progress while this one's oldest event backs off.
    return this.sqlite.query<PendingGitHubDelivery, [number]>(`
      SELECT pending.*, subscriptions.webhook_url, subscriptions.thread_id
      FROM pending_github_deliveries AS pending
      JOIN subscriptions ON subscriptions.id = pending.subscription_id
      WHERE pending.next_attempt_at <= ? AND NOT EXISTS (
        SELECT 1 FROM pending_github_deliveries AS older
        WHERE older.subscription_id = pending.subscription_id AND older.id < pending.id
      )
      ORDER BY pending.next_attempt_at, pending.id LIMIT 1
    `).get(now)
  }

  completeGitHubDelivery(id: number): void {
    this.sqlite.transaction(() => {
      // The user may have unsubscribed while the HTTP request was in flight.
      this.sqlite.query(`
        INSERT OR IGNORE INTO deliveries (subscription_id, delivery_id, event, delivered_at)
        SELECT subscription_id, delivery_id, event, ? FROM pending_github_deliveries WHERE id = ?
      `).run(new Date().toISOString(), id)
      this.sqlite.query("DELETE FROM pending_github_deliveries WHERE id = ?").run(id)
    })()
  }

  failGitHubDelivery(id: number, webhookUrl: string, now: number, nextAttemptAt: number, status: number | null): number | null {
    // A replacement endpoint must not inherit backoff from an old in-flight request.
    return this.sqlite.query<{ next_attempt_at: number }, [string, string, number, number | null, number]>(`
      UPDATE pending_github_deliveries SET attempts = attempts + 1,
        last_attempt_at = ?, next_attempt_at = CASE WHEN
          (SELECT webhook_url FROM subscriptions WHERE id = subscription_id) = ? THEN ? ELSE 0 END,
        last_http_status = ? WHERE id = ? RETURNING next_attempt_at
    `).get(new Date(now).toISOString(), webhookUrl, nextAttemptAt, status, id)?.next_attempt_at ?? null
  }

  githubDeliveryStatus(subscriptionId: string) {
    const oldest = this.sqlite.query<{
      created_at: string; attempts: number; last_attempt_at: string | null;
      last_http_status: number | null; next_attempt_at: number
    }, [string]>(`
      SELECT created_at, attempts, last_attempt_at, last_http_status, next_attempt_at
      FROM pending_github_deliveries WHERE subscription_id = ? ORDER BY id LIMIT 1
    `).get(subscriptionId)
    const pending = this.sqlite.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM pending_github_deliveries WHERE subscription_id = ?",
    ).get(subscriptionId)!.count
    return {
      pending,
      oldestPendingAt: oldest?.created_at ?? null,
      attempts: oldest?.attempts ?? 0,
      lastAttemptAt: oldest?.last_attempt_at ?? null,
      lastHttpStatus: oldest?.last_http_status ?? null,
      nextAttemptAt: oldest?.next_attempt_at ? new Date(oldest.next_attempt_at).toISOString() : null,
    }
  }

  pendingGitHubDeliveryCount(): number {
    return this.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_github_deliveries")
      .get()!.count
  }

  upsertFeed(input: Omit<FeedSubscription, "id" | "createdAt">, baseline: FeedEntry[]): FeedSubscription {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<FeedSubscriptionRow, [string, string]>(`
        SELECT * FROM feed_subscriptions WHERE thread_id = ? AND feed_url = ?
      `).get(input.threadId, input.feedUrl)
      const subscription: FeedSubscription = {
        ...input,
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
            (id, thread_id, feed_url, webhook_url, behavior, etag, last_modified, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

  deleteFeed(threadId: string, id: string): boolean {
    return this.sqlite.query("DELETE FROM feed_subscriptions WHERE id = ? AND thread_id = ?")
      .run(id, threadId).changes > 0
  }

  close(): void {
    this.sqlite.close()
  }
}

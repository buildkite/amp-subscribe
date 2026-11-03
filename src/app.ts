import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { OrbIdentity } from "./auth"
import { normalizeBuildkiteEvent, verifyBuildkiteSignature } from "./buildkite"
import { SubscriptionDatabase } from "./database"
import { fetchFeed, type FetchedFeed } from "./feeds"
import { MetricsRegistry } from "./metrics"
import {
  buildkiteEvents,
  type BuildkiteEvent,
  type BuildkiteSubscription,
  type SubscriptionBehavior,
  type SubscriptionDeliveryMode,
  type WebhookBinding,
} from "./types"

export interface SubscriptionBridgeConfig {
  databasePath: string
  buildkiteWebhookSecret: string
  buildkiteAllowedOrganizations: string[]
  allowedWebhookHosts: string[]
  authenticate: (request: Request) => Promise<OrbIdentity>
  allowLegacyWebhooks?: boolean
  fetchFeed?: (url: string, conditional?: { etag?: string | null; lastModified?: string | null }) => Promise<FetchedFeed>
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function logWebhookOutcome(
  subscription: Pick<BuildkiteSubscription, "id" | "threadId" | "createdAt" | "webhookUrl" | "webhookBinding">,
  response: Response | null,
  details: Record<string, unknown>,
): void {
  // Capability URLs and response bodies can contain credentials. Log only a
  // fingerprint and allowlisted response headers for cross-service correlation.
  console.warn(JSON.stringify({
    level: "warn",
    timestamp: new Date().toISOString(),
    subscriptionId: subscription.id,
    threadId: subscription.threadId,
    subscriptionCreatedAt: subscription.createdAt,
    webhookBinding: subscription.webhookBinding,
    webhookHost: new URL(subscription.webhookUrl).hostname,
    webhookUrlHash: createHash("sha256").update(subscription.webhookUrl).digest("hex"),
    httpStatus: response?.status ?? null,
    requestId: response?.headers.get("x-request-id")?.slice(0, 256) ?? null,
    flyRequestId: response?.headers.get("fly-request-id")?.slice(0, 256) ?? null,
    ...details,
  }))
}

function isAllowedWebhookUrl(value: string, allowedHosts: string[]): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && allowedHosts.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  } catch {
    return false
  }
}

function validBuildkiteEvents(value: unknown): value is BuildkiteEvent[] {
  return Array.isArray(value) && value.length > 0 && value.every((event) =>
    typeof event === "string" && buildkiteEvents.includes(event as BuildkiteEvent),
  )
}

function validBuildkiteSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value)
}

function validBuildkiteBranch(value: unknown): value is string {
  return typeof value === "string" && /^[^\u0000-\u001f\u007f\u2028\u2029]{1,255}$/.test(value)
}

function validBuildkiteCommit(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
}

function validBehavior(value: unknown): value is SubscriptionBehavior {
  return value === "notify" || value === "investigate" || value === "implement"
}

function validDeliveryMode(value: unknown): value is SubscriptionDeliveryMode {
  return value === "automatic" || value === "queue" || value === "steer"
}

function parseWebhookBinding(value: unknown): WebhookBinding | null {
  if (value === undefined) return "legacy"
  return value === "legacy" || value === "thread_v1" ? value : null
}

function rejectLegacyWebhook(threadId: string): Response {
  console.warn(JSON.stringify({ event: "legacy_webhook_rejected", threadId, timestamp: new Date().toISOString() }))
  return json({ error: "Legacy webhooks are disabled; update and reload the subscribe plugin" }, 409)
}

export function createSubscriptionBridge(config: SubscriptionBridgeConfig) {
  if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true })
  const database = new SubscriptionDatabase(config.databasePath)
  const feedFetcher = config.fetchFeed ?? fetchFeed

  const metrics = new MetricsRegistry()
  const feedSubscriptionsGauge = metrics.gauge(
    "amp_subscribe_feed_subscriptions",
    "Current number of feed subscriptions.",
  )
  const buildkiteSubscriptionsGauge = metrics.gauge(
    "amp_subscribe_buildkite_subscriptions",
    "Current number of Buildkite pipeline subscriptions.",
  )
  const apiRequestsTotal = metrics.counter(
    "amp_subscribe_api_requests_total",
    "Subscription API requests, by route, method and response status.",
  )
  const webhookBindingsGauge = metrics.gauge(
    "amp_subscribe_webhook_bindings",
    "Current subscriptions by source and webhook binding version, not successful migrations.",
  )
  const feedPollTotal = metrics.counter(
    "amp_subscribe_feed_poll_total",
    "Feed polling outcomes, by result.",
  )
  const buildkiteWebhookEventsReceivedTotal = metrics.counter(
    "amp_subscribe_buildkite_webhook_events_received_total",
    "Buildkite webhook deliveries received with a valid signature, by event type.",
  )
  const buildkiteWebhookSignatureFailuresTotal = metrics.counter(
    "amp_subscribe_buildkite_webhook_signature_failures_total",
    "Buildkite webhook deliveries rejected for an invalid or stale HMAC signature.",
  )
  const buildkiteWebhookDeliveriesTotal = metrics.counter(
    "amp_subscribe_buildkite_webhook_deliveries_total",
    "Attempts to forward a matched Buildkite event to an Amp durable webhook, by outcome.",
  )
  for (const outcome of ["delivered", "failed", "removed"]) buildkiteWebhookDeliveriesTotal.inc({ outcome }, 0)
  for (const result of ["checked", "delivered", "failed", "removed"]) feedPollTotal.inc({ result }, 0)
  buildkiteWebhookSignatureFailuresTotal.inc({}, 0)

  function refreshGauges(): void {
    feedSubscriptionsGauge.set({}, database.countFeedSubscriptions())
    buildkiteSubscriptionsGauge.set({}, database.countBuildkiteSubscriptions())
    const bindings = database.countWebhookBindings()
    for (const source of ["feed", "buildkite"]) {
      for (const binding of ["legacy", "thread_v1"]) {
        webhookBindingsGauge.set({ source, binding },
          bindings.find((row) => row.source === source && row.binding === binding)?.count ?? 0)
      }
    }
  }

  async function updateWebhook(request: Request): Promise<Response> {
    const identity = await config.authenticate(request).catch(() => null)
    if (!identity) return json({ error: "unauthorized" }, 401)
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405)
    const input = await request.json().catch(() => null) as Record<string, unknown> | null
    const webhookBinding = parseWebhookBinding(input?.webhookBinding)
    if (!webhookBinding) return json({ error: "invalid webhookBinding" }, 400)
    if (webhookBinding === "legacy" && config.allowLegacyWebhooks === false) return rejectLegacyWebhook(identity.threadId)
    if (typeof input?.webhookUrl !== "string" || !isAllowedWebhookUrl(input.webhookUrl, config.allowedWebhookHosts)) {
      return json({ error: "webhookUrl host is not allowed" }, 400)
    }
    const changed = database.updateWebhook(identity.threadId, input.webhookUrl, webhookBinding)
    console.info(JSON.stringify({ event: "webhook_binding_updated", threadId: identity.threadId, webhookBinding,
      changed, webhookUrlHash: createHash("sha256").update(input.webhookUrl).digest("hex"),
      timestamp: new Date().toISOString() }))
    return new Response(null, { status: 204 })
  }

  async function buildkiteSubscriptions(request: Request): Promise<Response> {
    const identity = await config.authenticate(request).catch(() => null)
    if (!identity) return json({ error: "unauthorized" }, 401)

    if (request.method === "GET") {
      return json({ subscriptions: database.listBuildkite(identity.threadId).map(({ webhookUrl: _, ...item }) => item) })
    }

    if (request.method === "POST") {
      const input = await request.json().catch(() => null) as Record<string, unknown> | null
      const organization = typeof input?.organization === "string" ? input.organization.toLowerCase() : ""
      const pipeline = typeof input?.pipeline === "string" ? input.pipeline.toLowerCase() : ""
      const branch = input?.branch
      const commit = input?.commit
      const webhookUrl = input?.webhookUrl
      const events = input?.events
      const behavior = input?.behavior
      const deliveryMode = input?.deliveryMode
      const webhookBinding = parseWebhookBinding(input?.webhookBinding)
      if (!webhookBinding) return json({ error: "invalid webhookBinding" }, 400)
      if (webhookBinding === "legacy" && config.allowLegacyWebhooks === false) return rejectLegacyWebhook(identity.threadId)
      if (!validBuildkiteSlug(organization)
        || !config.buildkiteAllowedOrganizations.map((item) => item.toLowerCase()).includes(organization)) {
        return json({ error: "organization is not allowed" }, 400)
      }
      if (!validBuildkiteSlug(pipeline)) return json({ error: "invalid pipeline" }, 400)
      if (branch !== undefined && !validBuildkiteBranch(branch)) {
        return json({ error: "invalid branch" }, 400)
      }
      if (commit !== undefined && !validBuildkiteCommit(commit)) {
        return json({ error: "commit must be a full 40- or 64-character hexadecimal SHA" }, 400)
      }
      if (typeof webhookUrl !== "string" || !isAllowedWebhookUrl(webhookUrl, config.allowedWebhookHosts)) {
        return json({ error: "webhookUrl host is not allowed" }, 400)
      }
      if (!validBuildkiteEvents(events)) return json({ error: "invalid events" }, 400)
      if (!validBehavior(behavior)) return json({ error: "invalid behavior" }, 400)
      if (deliveryMode !== undefined && !validDeliveryMode(deliveryMode)) {
        return json({ error: "invalid deliveryMode" }, 400)
      }
      const subscription = database.upsertBuildkite({
        threadId: identity.threadId,
        organization,
        pipeline,
        ...(branch !== undefined ? { branch } : {}),
        ...(commit !== undefined ? { commit } : {}),
        webhookUrl,
        events,
        behavior,
        deliveryMode,
      }, webhookBinding)
      console.info(JSON.stringify({ event: "subscription_registered", source: "buildkite",
        threadId: identity.threadId, subscriptionId: subscription.id, webhookBinding,
        timestamp: new Date().toISOString() }))
      const { webhookUrl: _, ...safeSubscription } = subscription
      return json({ subscription: safeSubscription }, 201)
    }

    if (request.method === "DELETE") {
      const input = await request.json().catch(() => null) as Record<string, unknown> | null
      if (typeof input?.id !== "string") return json({ error: "id is required" }, 400)
      const deleted = database.deleteBuildkite(identity.threadId, input.id)
      if (deleted) console.info(JSON.stringify({ event: "subscription_unsubscribed", source: "buildkite",
        threadId: identity.threadId, subscriptionId: input.id, timestamp: new Date().toISOString() }))
      return deleted ? new Response(null, { status: 204 }) : json({ error: "subscription not found" }, 404)
    }

    return json({ error: "method not allowed" }, 405)
  }

  async function buildkiteWebhook(request: Request): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer())
    const signature = request.headers.get("x-buildkite-signature") ?? ""
    if (!await verifyBuildkiteSignature(config.buildkiteWebhookSecret, body, signature)) {
      buildkiteWebhookSignatureFailuresTotal.inc()
      return json({ error: "invalid signature" }, 401)
    }
    const eventName = request.headers.get("x-buildkite-event") ?? ""
    const metricEvent = buildkiteEvents.includes(eventName as BuildkiteEvent) ? eventName : "unknown"
    buildkiteWebhookEventsReceivedTotal.inc({ event: metricEvent })
    const deliveryId = createHash("sha256").update(eventName).update("\0").update(body).digest("hex")
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as unknown
    } catch {
      return json({ error: "invalid JSON" }, 400)
    }
    const event = normalizeBuildkiteEvent(eventName, deliveryId, payload)
    if (!event) return json({ accepted: true, matchedEvents: 0, delivered: 0, removed: 0 }, 202)
    if (!config.buildkiteAllowedOrganizations.map((item) => item.toLowerCase()).includes(event.organization)) {
      return json({ error: "organization is not allowed" }, 403)
    }

    let delivered = 0
    let failed = 0
    let removed = 0
    let deduplicated = 0
    const subscriptions = database.matchingBuildkite(
      event.organization, event.pipeline.slug, event.event, event.build.branch, event.build.commit,
    )
    for (const subscription of subscriptions) {
      if (database.wasBuildkiteDelivered(subscription.id, deliveryId, event.event)) {
        deduplicated += 1
        continue
      }
      const idempotencyKey = `buildkite:${deliveryId}:${subscription.id}`
      const details = { source: "buildkite", organization: event.organization, pipeline: event.pipeline.slug,
        deliveryId, buildkiteEvent: event.event, buildId: event.build.id, idempotencyKey }
      let response: Response
      try {
        response = await fetch(subscription.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ ...event, behavior: subscription.behavior,
            deliveryMode: subscription.deliveryMode, targetThreadID: subscription.threadId }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        failed += 1
        buildkiteWebhookDeliveriesTotal.inc({ outcome: "failed" })
        logWebhookOutcome(subscription, null, { ...details, event: "webhook_delivery_failed", reason: "transport_error" })
        continue
      }
      if (response.status === 404 || response.status === 410) {
        if (!database.deleteBuildkite(subscription.threadId, subscription.id, subscription.webhookUrl)) {
          failed += 1
          buildkiteWebhookDeliveriesTotal.inc({ outcome: "failed" })
          logWebhookOutcome(subscription, response, { ...details, event: "webhook_delivery_failed",
            reason: "subscription_changed_or_deleted" })
          continue
        }
        removed += 1
        buildkiteWebhookDeliveriesTotal.inc({ outcome: "removed" })
        logWebhookOutcome(subscription, response, { ...details, event: "subscription_removed",
          reason: "webhook_not_found_or_gone" })
        continue
      }
      if (!response.ok) {
        failed += 1
        buildkiteWebhookDeliveriesTotal.inc({ outcome: "failed" })
        logWebhookOutcome(subscription, response, { ...details, event: "webhook_delivery_failed", reason: "http_error" })
        continue
      }
      database.markBuildkiteDelivered(subscription.id, deliveryId, event.event)
      delivered += 1
      buildkiteWebhookDeliveriesTotal.inc({ outcome: "delivered" })
    }
    console.info(JSON.stringify({ event: "buildkite_webhook_processed", deliveryId, buildkiteEvent: event.event,
      organization: event.organization, pipeline: event.pipeline.slug, matchedSubscriptions: subscriptions.length,
      deduplicated, delivered, failed, removed, timestamp: new Date().toISOString() }))
    if (failed > 0) return json({ error: "Amp webhook delivery failed", failed, delivered, removed }, 502)
    return json({ accepted: true, matchedEvents: 1, delivered, removed }, 202)
  }

  async function feedSubscriptions(request: Request): Promise<Response> {
    const identity = await config.authenticate(request).catch(() => null)
    if (!identity) return json({ error: "unauthorized" }, 401)

    if (request.method === "GET") {
      const subscriptions = database.listFeeds(identity.threadId).map(({
        webhookUrl: _, etag: __, lastModified: ___, ...item
      }) => item)
      return json({ subscriptions })
    }

    if (request.method === "POST") {
      const input = await request.json().catch(() => null) as Record<string, unknown> | null
      const feedUrl = input?.feedUrl
      const webhookUrl = input?.webhookUrl
      const behavior = input?.behavior
      const webhookBinding = parseWebhookBinding(input?.webhookBinding)
      if (!webhookBinding) return json({ error: "invalid webhookBinding" }, 400)
      if (webhookBinding === "legacy" && config.allowLegacyWebhooks === false) return rejectLegacyWebhook(identity.threadId)
      if (typeof feedUrl !== "string") return json({ error: "feedUrl is required" }, 400)
      if (typeof webhookUrl !== "string" || !isAllowedWebhookUrl(webhookUrl, config.allowedWebhookHosts)) {
        return json({ error: "webhookUrl host is not allowed" }, 400)
      }
      if (!validBehavior(behavior)) return json({ error: "invalid behavior" }, 400)
      let fetched: FetchedFeed
      let canonicalUrl: string
      try {
        const url = new URL(feedUrl)
        url.hash = ""
        canonicalUrl = url.href
        fetched = await feedFetcher(feedUrl)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not read feed" }, 400)
      }
      if (!fetched.feed) return json({ error: "Feed returned no content" }, 400)
      const subscription = database.upsertFeed({
        threadId: identity.threadId,
        feedUrl: canonicalUrl,
        webhookUrl,
        behavior,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      }, fetched.feed.entries, webhookBinding)
      console.info(JSON.stringify({ event: "subscription_registered", source: "feed", threadId: identity.threadId,
        subscriptionId: subscription.id, webhookBinding, timestamp: new Date().toISOString() }))
      const { webhookUrl: _, etag: __, lastModified: ___, ...safeSubscription } = subscription
      return json({ subscription: safeSubscription }, 201)
    }

    if (request.method === "DELETE") {
      const input = await request.json().catch(() => null) as Record<string, unknown> | null
      if (typeof input?.id !== "string") return json({ error: "id is required" }, 400)
      const deleted = database.deleteFeed(identity.threadId, input.id)
      if (deleted) console.info(JSON.stringify({ event: "subscription_unsubscribed", source: "feed",
        threadId: identity.threadId, subscriptionId: input.id, timestamp: new Date().toISOString() }))
      return deleted
        ? new Response(null, { status: 204 })
        : json({ error: "subscription not found" }, 404)
    }

    return json({ error: "method not allowed" }, 405)
  }

  let polling = false
  async function pollFeeds(): Promise<{ checked: number; delivered: number; failed: number; removed: number }> {
    if (polling) return { checked: 0, delivered: 0, failed: 0, removed: 0 }
    polling = true
    let checked = 0
    let delivered = 0
    let failed = 0
    let removed = 0
    try {
      for (const subscription of database.allFeeds()) {
        checked += 1
        feedPollTotal.inc({ result: "checked" })
        let fetched: FetchedFeed
        try {
          fetched = await feedFetcher(subscription.feedUrl, {
            etag: subscription.etag,
            lastModified: subscription.lastModified,
          })
        } catch {
          failed += 1
          feedPollTotal.inc({ result: "failed" })
          continue
        }
        if (!fetched.feed) continue
        let feedFailed = false
        for (const entry of [...fetched.feed.entries].reverse()) {
          if (!database.feedEntryChanged(subscription.id, entry)) continue
          const body = JSON.stringify({
            schemaVersion: 1,
            source: "feed",
            feed: { title: fetched.feed.title, url: subscription.feedUrl },
            entry: {
              id: entry.id,
              title: entry.title,
              url: entry.url,
              publishedAt: entry.publishedAt,
              updatedAt: entry.updatedAt,
            },
            behavior: subscription.behavior,
            targetThreadID: subscription.threadId,
          })
          const deliveryLog = { source: "feed", entryFingerprint: entry.fingerprint,
            idempotencyKey: `feed:${subscription.id}:${entry.fingerprint}` }
          let response: Response
          try {
            response = await fetch(subscription.webhookUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": `feed:${subscription.id}:${entry.fingerprint}`,
              },
              body,
              signal: AbortSignal.timeout(10_000),
            })
          } catch {
            failed += 1
            feedFailed = true
            feedPollTotal.inc({ result: "failed" })
            logWebhookOutcome(subscription, null, { ...deliveryLog, event: "webhook_delivery_failed", reason: "transport_error" })
            continue
          }
          if (response.status === 404 || response.status === 410) {
            if (!database.deleteFeed(subscription.threadId, subscription.id, subscription.webhookUrl)) {
              failed += 1
              feedFailed = true
              feedPollTotal.inc({ result: "failed" })
              logWebhookOutcome(subscription, response, { ...deliveryLog, event: "webhook_delivery_failed", reason: "subscription_changed_or_deleted" })
              break
            }
            removed += 1
            feedPollTotal.inc({ result: "removed" })
            logWebhookOutcome(subscription, response, {
              ...deliveryLog, event: "subscription_removed", reason: "webhook_not_found_or_gone",
              feedHost: new URL(subscription.feedUrl).hostname,
              feedUrlHash: createHash("sha256").update(subscription.feedUrl).digest("hex"),
              entryFingerprint: entry.fingerprint,
            })
            break
          }
          if (!response.ok) {
            failed += 1
            feedFailed = true
            feedPollTotal.inc({ result: "failed" })
            logWebhookOutcome(subscription, response, { ...deliveryLog, event: "webhook_delivery_failed", reason: "http_error" })
            continue
          }
          database.storeFeedEntry(subscription.id, entry)
          delivered += 1
          feedPollTotal.inc({ result: "delivered" })
        }
        if (!feedFailed) database.updateFeedCache(subscription.id, fetched.etag, fetched.lastModified)
      }
      return { checked, delivered, failed, removed }
    } finally {
      polling = false
    }
  }

  return {
    database,
    pollFeeds,
    metrics(): Response {
      refreshGauges()
      return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } })
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true })
      if (url.pathname === "/api/webhook") {
        const response = await updateWebhook(request)
        apiRequestsTotal.inc({ route: "webhook", method: request.method, status: String(response.status) })
        return response
      }
      if (url.pathname === "/api/feed-subscriptions") {
        const response = await feedSubscriptions(request)
        apiRequestsTotal.inc({
          route: "feed-subscriptions",
          method: request.method,
          status: String(response.status),
        })
        return response
      }
      if (url.pathname === "/api/buildkite-subscriptions") {
        const response = await buildkiteSubscriptions(request)
        apiRequestsTotal.inc({ route: "buildkite-subscriptions", method: request.method, status: String(response.status) })
        return response
      }
      if (request.method === "POST" && url.pathname === "/buildkite/webhook") return buildkiteWebhook(request)
      return json({ error: "not found" }, 404)
    },
  }
}

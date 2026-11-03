import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createSubscriptionBridge } from "../src/app"
import { hmacSha256 } from "../src/crypto"

const config = {
  databasePath: ":memory:",
  buildkiteWebhookSecret: "buildkite-secret",
  buildkiteAllowedOrganizations: ["buildkite"],
  allowedWebhookHosts: ["example.test"],
  authenticate: async (request: Request) => {
    if (request.headers.get("authorization") !== "Bearer oidc-token") throw new Error("unauthorized")
    return {
      threadId: request.headers.get("x-test-thread-id") ?? "T-test",
      workspaceId: "W-test", projectId: "P-test", userId: "U-test",
    }
  },
}

const openBridges: ReturnType<typeof createSubscriptionBridge>[] = []

afterEach(() => {
  for (const bridge of openBridges.splice(0)) bridge.database.close()
  mock.restore()
})

function bridge() {
  const instance = createSubscriptionBridge(config)
  openBridges.push(instance)
  return instance
}

function apiRequest(path: string, body?: unknown, method = "POST", threadID?: string) {
  return new Request(`https://bridge.test${path}`, {
    method,
    headers: {
      authorization: "Bearer oidc-token", "content-type": "application/json",
      ...(threadID ? { "x-test-thread-id": threadID } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  })
}

function feedApiRequest(body: unknown, method = "POST", threadID?: string) {
  return apiRequest("/api/feed-subscriptions", body, method, threadID)
}

function buildkiteApiRequest(body: unknown, method = "POST", threadID?: string) {
  return apiRequest("/api/buildkite-subscriptions", body, method, threadID)
}

async function buildkiteWebhookRequest(body: string, timestamp = Math.floor(Date.now() / 1_000)) {
  const signature = (await hmacSha256("buildkite-secret", `${timestamp}.${body}`)).slice("sha256=".length)
  return new Request("https://bridge.test/buildkite/webhook", {
    method: "POST",
    headers: { "x-buildkite-event": "build.finished", "x-buildkite-signature": `timestamp=${timestamp},signature=${signature}` },
    body,
  })
}

const buildkitePayload = {
  event: "build.finished",
  pipeline: {
    id: "849411f9-9e6d-4739-a0d8-e247088e9b52", slug: "amp-subscribe",
    web_url: "https://buildkite.com/buildkite/amp-subscribe",
  },
  build: {
    id: "f62a1b4d-10f9-4790-bc1c-e2c3a0c80983", number: 42, state: "failed", blocked: false,
    branch: "main", commit: "a".repeat(40), web_url: "https://buildkite.com/buildkite/amp-subscribe/builds/42",
    finished_at: "2026-09-21T09:05:00.000Z", message: "UNTRUSTED_SENTINEL", env: { SECRET: "UNTRUSTED_SENTINEL" },
  },
}
const buildkiteInput = {
  organization: "buildkite", pipeline: "amp-subscribe", webhookUrl: "https://hooks.example.test/secret-capability",
  events: ["build.finished", "build.skipped"], behavior: "investigate",
}

describe("subscription bridge", () => {
  test("requires API authentication", async () => {
    const app = bridge()
    for (const path of ["/api/buildkite-subscriptions", "/api/feed-subscriptions", "/api/webhook"]) {
      expect((await app.fetch(new Request(`https://bridge.test${path}`))).status).toBe(401)
    }
  })

  test("retired GitHub endpoints return not found", async () => {
    const app = bridge()
    for (const method of ["GET", "POST", "DELETE"]) {
      expect((await app.fetch(apiRequest("/api/subscriptions", {}, method))).status).toBe(404)
    }
    expect((await app.fetch(new Request("https://bridge.test/github/webhook", { method: "POST", body: "{}" }))).status).toBe(404)
  })

  test("retirement rejects legacy writes on every binding route without changing subscriptions", async () => {
    const app = createSubscriptionBridge({ ...config, allowLegacyWebhooks: false, fetchFeed: async () => ({
      feed: { title: "Status", entries: [] }, etag: null, lastModified: null,
    }) })
    openBridges.push(app)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const input = { ...buildkiteInput, feedUrl: "https://status.example/feed" }
    for (const [path, method, success] of [
      ["/api/buildkite-subscriptions", "POST", 201], ["/api/feed-subscriptions", "POST", 201], ["/api/webhook", "PUT", 204],
    ] as const) {
      const send = (webhookBinding: unknown, webhookUrl = input.webhookUrl) => app.fetch(apiRequest(path, { ...input, webhookUrl, webhookBinding }, method))
      expect((await send("thread_v1")).status).toBe(success)
      const before = [app.database.listBuildkite("T-test"), app.database.listFeeds("T-test")]
      for (const binding of [undefined, "legacy"]) expect((await send(binding, "https://hooks.example.test/shared")).status).toBe(409)
      for (const binding of [null, "future", 1]) expect((await send(binding)).status).toBe(400)
      expect([app.database.listBuildkite("T-test"), app.database.listFeeds("T-test")]).toEqual(before)
    }
    expect(warn.mock.calls).toHaveLength(6)
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))))
      .toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ event: "legacy_webhook_rejected", threadId: "T-test" })))
    expect(JSON.stringify(warn.mock.calls)).not.toContain("https://")
  })

  test("webhook migration authenticates and validates the replacement endpoint", async () => {
    const app = bridge()
    expect((await app.fetch(new Request("https://bridge.test/api/webhook", { method: "PUT" }))).status).toBe(401)
    expect((await app.fetch(apiRequest("/api/webhook", undefined, "GET"))).status).toBe(405)
    for (const webhookUrl of [null, "http://hooks.example.test/secret", "https://other.test/secret"]) {
      expect((await app.fetch(apiRequest("/api/webhook", { webhookUrl }, "PUT"))).status).toBe(400)
    }
  })

  test("migrates only the authenticated thread's subscriptions without losing history or feed baselines", async () => {
    const app = bridge()
    const info = spyOn(console, "info").mockImplementation(() => {})
    const baseline = { id: "entry-1", fingerprint: "version-1", title: null, url: null, publishedAt: null, updatedAt: null }
    for (const threadId of ["T-test", "T-other"]) {
      const subscription = app.database.upsertBuildkite({
        ...buildkiteInput, threadId, events: ["build.finished"], behavior: "implement", deliveryMode: "queue",
        branch: "Feature/CI", commit: "a".repeat(40),
      })
      app.database.markBuildkiteDelivered(subscription.id, "delivery-before-migration", "build.finished")
      app.database.upsertFeed({
        threadId, feedUrl: "https://status.example/feed", webhookUrl: subscription.webhookUrl,
        behavior: "notify", etag: "etag-before", lastModified: "last-modified-before",
      }, [baseline])
    }
    const buildkite = app.database.listBuildkite("T-test")[0]!
    const feed = app.database.listFeeds("T-test")[0]!
    const otherBuildkite = app.database.listBuildkite("T-other")
    const otherFeeds = app.database.listFeeds("T-other")
    const webhookUrl = "https://hooks.example.test/thread-specific-secret"
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.fetch(apiRequest("/api/webhook", { webhookUrl, webhookBinding: "thread_v1", threadId: "T-other" }, "PUT"))
      expect(response.status).toBe(204)
      expect(await response.text()).toBe("")
    }
    expect(app.database.listBuildkite("T-test")).toEqual([{ ...buildkite, webhookUrl, webhookBinding: "thread_v1" }])
    expect(app.database.listFeeds("T-test")).toEqual([{ ...feed, webhookUrl, webhookBinding: "thread_v1" }])
    expect(app.database.wasBuildkiteDelivered(buildkite.id, "delivery-before-migration", "build.finished")).toBe(true)
    expect(app.database.feedEntryChanged(feed.id, baseline)).toBe(false)
    expect(app.database.listBuildkite("T-other")).toEqual(otherBuildkite)
    expect(app.database.listFeeds("T-other")).toEqual(otherFeeds)
    const logs = info.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(logs.map((line) => line.changed)).toEqual([{ feed: 1, buildkite: 1 }, { feed: 0, buildkite: 0 }])
    expect(JSON.stringify(logs)).not.toContain(webhookUrl)
    expect(await (await app.fetch(buildkiteApiRequest(undefined, "GET"))).json())
      .toMatchObject({ subscriptions: [{ webhookBinding: "thread_v1" }] })
  })

  test.each([404, 410])("a late %i from the old webhook cannot delete migrated Buildkite or feed subscriptions", async (status) => {
    const entry = { id: "entry-1", fingerprint: "version-1", title: null, url: null, publishedAt: null, updatedAt: null }
    const app = createSubscriptionBridge({ ...config, fetchFeed: async () => ({
      feed: { title: "Status", entries: [entry] }, etag: "new-etag", lastModified: null,
    }) })
    openBridges.push(app)
    const subscription = app.database.upsertBuildkite({ ...buildkiteInput, threadId: "T-test", events: ["build.finished"], behavior: "implement" })
    const feed = app.database.upsertFeed({
      threadId: "T-test", feedUrl: "https://status.example/feed", webhookUrl: subscription.webhookUrl,
      behavior: "notify", etag: null, lastModified: null,
    }, [])
    const send = async () => app.fetch(await buildkiteWebhookRequest(JSON.stringify(buildkitePayload)))
    const response = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    let calls = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input) => {
      if (++calls === 2) started.resolve()
      return response.promise
    }) as typeof fetch)
    const buildkiteRequest = send()
    const feedPoll = app.pollFeeds()
    await started.promise
    const replacement = "https://hooks.example.test/replacement"
    expect((await app.fetch(apiRequest("/api/webhook", { webhookUrl: replacement }, "PUT"))).status).toBe(204)
    response.resolve(new Response(null, { status }))
    expect(await (await buildkiteRequest).json()).toMatchObject({ failed: 1, removed: 0 })
    expect(await feedPoll).toMatchObject({ failed: 1, removed: 0 })
    expect(app.database.listBuildkite("T-test")).toEqual([{ ...subscription, webhookUrl: replacement }])
    expect(app.database.listFeeds("T-test")).toEqual([{ ...feed, webhookUrl: replacement }])
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
    expect(await (await send()).json()).toMatchObject({ delivered: 1 })
    expect(await app.pollFeeds()).toMatchObject({ delivered: 1 })
    expect(fetchSpy.mock.calls.slice(2).map(([url]) => url)).toEqual([replacement, replacement])
  })

  test("registers, routes, and deduplicates Buildkite pipeline subscriptions", async () => {
    const app = bridge()
    for (const [threadID, deliveryMode] of [["T-buildkite-one", "queue"], ["T-buildkite-two", "steer"]] as const) {
      const response = await app.fetch(buildkiteApiRequest({ ...buildkiteInput, webhookBinding: "thread_v1", deliveryMode }, "POST", threadID))
      expect(response.status).toBe(201)
      expect(await response.text()).not.toContain("secret-capability")
    }
    const forwarded: Array<{ body: string; idempotencyKey: string | null }> = []
    spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      forwarded.push({ body: String(init?.body), idempotencyKey: new Headers(init?.headers).get("idempotency-key") })
      return new Response(null, { status: 202 })
    }) as typeof fetch)
    const body = JSON.stringify(buildkitePayload)
    expect((await app.fetch(await buildkiteWebhookRequest(body))).status).toBe(202)
    expect((await app.fetch(await buildkiteWebhookRequest(body))).status).toBe(202)
    expect(forwarded).toHaveLength(2)
    expect(forwarded.map((item) => JSON.parse(item.body).targetThreadID).sort()).toEqual(["T-buildkite-one", "T-buildkite-two"])
    expect(forwarded.map((item) => JSON.parse(item.body).deliveryMode).sort()).toEqual(["queue", "steer"])
    expect(new Set(forwarded.map((item) => item.idempotencyKey)).size).toBe(2)
    expect(forwarded.every((item) => !item.body.includes("UNTRUSTED_SENTINEL"))).toBe(true)
    const listed = await app.fetch(buildkiteApiRequest(undefined, "GET", "T-buildkite-one"))
    expect(await listed.json()).toMatchObject({ subscriptions: [{ organization: "buildkite", pipeline: "amp-subscribe" }] })
  })

  test("routes Buildkite events only to matching branch and commit scopes", async () => {
    const app = bridge()
    const commit = "a1".repeat(20)
    for (const [threadID, filters] of [
      ["T-all", {}], ["T-branch", { branch: "Feature/CI" }], ["T-commit", { commit: commit.toUpperCase() }],
      ["T-both", { branch: "Feature/CI", commit }],
    ] as const) {
      expect((await app.fetch(buildkiteApiRequest({ ...buildkiteInput, ...filters }, "POST", threadID))).status).toBe(201)
    }
    expect(await (await app.fetch(buildkiteApiRequest(undefined, "GET", "T-commit"))).json()).toMatchObject({ subscriptions: [{ commit }] })
    const targets: string[] = []
    spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      targets.push(JSON.parse(String(init?.body)).targetThreadID)
      return new Response(null, { status: 202 })
    }) as typeof fetch)
    let number = 0
    for (const [branch, buildCommit, expected] of [
      ["Feature/CI", commit.toUpperCase(), ["T-all", "T-both", "T-branch", "T-commit"]],
      ["main", commit, ["T-all", "T-commit"]], ["feature/ci", commit, ["T-all", "T-commit"]],
      ["Feature/CI", "b2".repeat(20), ["T-all", "T-branch"]], ["Feature/CI", undefined, ["T-all", "T-branch"]],
      ["main", "b2".repeat(20), ["T-all"]],
    ] as const) {
      number += 1
      targets.length = 0
      const body = JSON.stringify({ ...buildkitePayload, build: {
        ...buildkitePayload.build, number, branch, commit: buildCommit,
        web_url: `https://buildkite.com/buildkite/amp-subscribe/builds/${number}`,
      } })
      expect((await app.fetch(await buildkiteWebhookRequest(body))).status).toBe(202)
      expect(targets.sort()).toEqual([...expected])
    }
  })

  test("rejects invalid Buildkite filters without broadening an existing subscription", async () => {
    const app = bridge()
    const input = { ...buildkiteInput, branch: "Feature/CI", commit: "a1".repeat(20), webhookBinding: "thread_v1" }
    expect((await app.fetch(buildkiteApiRequest(input))).status).toBe(201)
    const before = app.database.listBuildkite("T-test")
    for (const filters of [
      { branch: "" }, { branch: null }, { branch: 1 }, { branch: "x".repeat(256) }, { branch: "main\n" },
      { commit: "" }, { commit: null }, { commit: 1 }, { commit: "abc1234" }, { commit: "g".repeat(40) }, { commit: "a".repeat(41) },
    ]) {
      expect((await app.fetch(buildkiteApiRequest({ ...input, ...filters }))).status).toBe(400)
      expect(app.database.listBuildkite("T-test")).toEqual(before)
    }
    const sha256 = await app.fetch(buildkiteApiRequest({ ...input, commit: "C3".repeat(32) }))
    expect(sha256.status).toBe(201)
    expect(await sha256.json()).toMatchObject({ subscription: { commit: "c3".repeat(32) } })
  })

  test("rejects stale Buildkite signatures and subscriptions outside allowed organizations", async () => {
    const app = bridge()
    const registration = await app.fetch(buildkiteApiRequest({ ...buildkiteInput, organization: "other-org" }))
    expect(registration.status).toBe(400)
    expect(await registration.json()).toEqual({ error: "organization is not allowed" })
    expect((await app.fetch(await buildkiteWebhookRequest("{}", Math.floor(Date.now() / 1_000) - 301))).status).toBe(401)
  })

  test.each([404, 410, 503, 202, null])("logs Buildkite HTTP and transport failures without credentials (%s)", async (status) => {
    const app = bridge()
    const registration = await app.fetch(buildkiteApiRequest({ ...buildkiteInput,
      webhookUrl: "https://hooks.example.test/secret-capability?token=secret-query",
    }, "POST", "T-removal"))
    const { subscription } = await registration.json() as { subscription: { id: string; createdAt: string } }
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const fetchSpy = spyOn(globalThis, "fetch")
    if (status === null) fetchSpy.mockRejectedValue(new Error("secret-capability"))
    else fetchSpy.mockResolvedValue(new Response("secret-response-body", { status, headers: {
      "x-request-id": "amp-request-123", "fly-request-id": "fly-request-456", "set-cookie": "secret-cookie",
    } }))
    const send = async () => app.fetch(await buildkiteWebhookRequest(JSON.stringify(buildkitePayload)))
    const response = await send()
    const removed = status === 404 || status === 410
    expect(response.status).toBe(status === 503 || status === null ? 502 : 202)
    expect(await response.json()).toMatchObject({ removed: removed ? 1 : 0 })
    expect(app.database.listBuildkite("T-removal")).toHaveLength(removed ? 0 : 1)
    expect(warn).toHaveBeenCalledTimes(status === 202 ? 0 : 1)
    if (status === 202) return
    const line = warn.mock.calls[0]![0] as string
    expect(JSON.parse(line)).toMatchObject({
      level: "warn", event: removed ? "subscription_removed" : "webhook_delivery_failed",
      reason: removed ? "webhook_not_found_or_gone" : status === null ? "transport_error" : "http_error",
      subscriptionId: subscription.id, threadId: "T-removal", subscriptionCreatedAt: subscription.createdAt,
      webhookBinding: "legacy", webhookHost: "hooks.example.test",
      webhookUrlHash: "adfa88b122d5500d7af22e6c9cc2b27f0645df7af7df1a1d3c92e04830809e3e", httpStatus: status,
      requestId: status === null ? null : "amp-request-123", flyRequestId: status === null ? null : "fly-request-456",
      source: "buildkite", organization: "buildkite", pipeline: "amp-subscribe", buildkiteEvent: "build.finished",
    })
    expect(line).not.toContain("secret-")
    expect(Number.isNaN(Date.parse(JSON.parse(line).timestamp))).toBe(false)
    await send()
    expect(warn).toHaveBeenCalledTimes(removed ? 1 : 2)
  })

  test.each([404, 410])("logs feed removal without exposing feed or webhook credentials (%i)", async (status) => {
    const app = createSubscriptionBridge({ ...config, fetchFeed: async () => ({
      feed: { title: "secret-feed-title", entries: [{
        id: "secret-entry-id", fingerprint: "entry-fingerprint", title: null, url: null, publishedAt: null, updatedAt: null,
      }] }, etag: null, lastModified: null,
    }) })
    openBridges.push(app)
    const subscription = app.database.upsertFeed({
      threadId: "T-feed-removal", feedUrl: "https://status.example/feed.atom?token=secret-feed-token",
      webhookUrl: "https://hooks.example.test/secret-capability?token=secret-query", behavior: "notify", etag: null, lastModified: null,
    }, [])
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret-response-body", { status }))
    expect(await app.pollFeeds()).toEqual({ checked: 1, delivered: 0, failed: 0, removed: 1 })
    expect(app.database.listFeeds("T-feed-removal")).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]![0] as string
    expect(JSON.parse(line)).toMatchObject({
      event: "subscription_removed", subscriptionId: subscription.id, threadId: "T-feed-removal", source: "feed",
      httpStatus: status, requestId: null, flyRequestId: null, webhookHost: "hooks.example.test",
      webhookUrlHash: "adfa88b122d5500d7af22e6c9cc2b27f0645df7af7df1a1d3c92e04830809e3e",
      feedHost: "status.example", feedUrlHash: expect.stringMatching(/^[a-f0-9]{64}$/), entryFingerprint: "entry-fingerprint",
    })
    expect(line).not.toContain("secret-")
  })

  test("routes shared-webhook feed subscriptions by authenticated thread", async () => {
    const baseline = {
      id: "incident-1", fingerprint: "version-1", title: "Queue delays", url: "https://status.example/incidents/1",
      publishedAt: "2026-08-25T10:00:00.000Z", updatedAt: null,
    }
    let polled = false
    const app = createSubscriptionBridge({ ...config, fetchFeed: async () => ({
      feed: { title: "Service status", entries: polled ? [
        { ...baseline, fingerprint: "version-2", updatedAt: "2026-08-25T11:00:00.000Z" },
        { ...baseline, id: "incident-2", fingerprint: "new-entry", title: "API errors", url: "https://status.example/incidents/2" },
      ] : [baseline] }, etag: polled ? '"v2"' : '"v1"', lastModified: null,
    }) })
    openBridges.push(app)
    for (const threadID of ["T-thread-one", "T-thread-two"]) {
      const response = await app.fetch(feedApiRequest({
        targetThreadID: "T-attacker-controlled", feedUrl: "https://status.example/feed.atom",
        webhookUrl: "https://hooks.example.test/secret-capability", behavior: "notify",
      }, "POST", threadID))
      expect(response.status).toBe(201)
      expect(await response.text()).not.toContain("secret-capability")
    }
    const forwarded: Array<{ body: string; idempotencyKey: string | null }> = []
    spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      forwarded.push({ body: String(init?.body), idempotencyKey: new Headers(init?.headers).get("idempotency-key") })
      return new Response(null, { status: 202 })
    }) as typeof fetch)
    expect(await app.pollFeeds()).toMatchObject({ checked: 2, delivered: 0, failed: 0 })
    polled = true
    expect(await app.pollFeeds()).toMatchObject({ checked: 2, delivered: 4, failed: 0 })
    expect(await app.pollFeeds()).toMatchObject({ checked: 2, delivered: 0, failed: 0 })
    expect(forwarded).toHaveLength(4)
    expect(forwarded.map(({ body }) => JSON.parse(body).targetThreadID).sort())
      .toEqual(["T-thread-one", "T-thread-one", "T-thread-two", "T-thread-two"])
    expect(new Set(forwarded.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(4)
    expect(JSON.parse(forwarded[0]!.body)).toMatchObject({
      source: "feed", feed: { title: "Service status", url: "https://status.example/feed.atom" },
      entry: { id: "incident-2", title: "API errors" }, behavior: "notify",
    })
    expect(forwarded[0]?.idempotencyKey).toContain("new-entry")
    expect(forwarded.every(({ body }) => !body.includes("T-attacker-controlled"))).toBe(true)
  })
})

import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSubscriptionBridge } from "../src/app"
import { hmacSha256 } from "../src/crypto"

const bridges: ReturnType<typeof createSubscriptionBridge>[] = []
const directories: string[] = []
afterEach(() => {
  for (const app of bridges.splice(0)) app.database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  mock.restore()
})

function bridge(databasePath = ":memory:") {
  const app = createSubscriptionBridge({
    databasePath,
    githubWebhookSecret: "github-secret",
    allowedWebhookHosts: ["example.test"],
    authenticate: async () => ({ threadId: "T-target", userId: "U-test", projectId: "P-test", workspaceId: "W-test" }),
  })
  bridges.push(app)
  spyOn(console, "warn").mockImplementation(() => {})
  return app
}

function subscribe(app: ReturnType<typeof bridge>, threadId = "T-target") {
  return app.database.upsert({
    threadId, repository: "lox/project", targetType: "pull_request", pullRequestNumber: 17,
    webhookUrl: "https://hooks.example.test/archived-owner", events: ["review_comments"], behavior: "implement",
  })
}

async function send(app: ReturnType<typeof bridge>, id = "comment-91", commentId = 91) {
  const body = JSON.stringify({
    action: "created", repository: { id: 42, full_name: "lox/project" },
    pull_request: { number: 17 }, comment: { id: commentId, body: "UNTRUSTED_COMMENT" },
  })
  return app.fetch(new Request("https://bridge.test/github/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": await hmacSha256("github-secret", body),
      "x-github-event": "pull_request_review_comment", "x-github-delivery": id,
    },
    body,
  }))
}

test("an archived owner retains the subscription and retries durably after restart without GitHub redelivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "amp-delivery-"))
  directories.push(directory)
  const path = join(directory, "relay.sqlite")
  let app = bridge(path)
  const subscription = subscribe(app)
  let now = Date.now()
  spyOn(Date, "now").mockImplementation(() => now)
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }))
  expect(await (await send(app)).json()).toMatchObject({ accepted: true, queued: 1 })
  expect(fetchSpy).not.toHaveBeenCalled() // HTTP acknowledgement requires only a durable enqueue.
  expect(app.database.githubDeliveryStatus(subscription.id)).toMatchObject({ pending: 1, nextAttemptAt: null })
  await app.deliverGitHubEvents()
  expect(app.database.list("T-target")).toEqual([subscription])
  expect(app.database.wasDelivered(subscription.id, "comment-91", "review_comments")).toBe(false)
  const status = await app.fetch(new Request("https://bridge.test/api/subscriptions"))
  expect(await status.json()).toMatchObject({ subscriptions: [{ delivery: { pending: 1, attempts: 1, lastHttpStatus: 404 } }] })
  const firstAttempt = fetchSpy.mock.calls[0]![1]!
  expect(String(firstAttempt.body)).not.toContain("UNTRUSTED_COMMENT")

  bridges.pop()!.database.close()
  app = bridge(path)
  expect(await (await send(app)).json()).toMatchObject({ queued: 0 })
  await app.deliverGitHubEvents()
  expect(fetchSpy).toHaveBeenCalledTimes(1) // Persisted backoff survives restart and duplicate intake.
  now += 60_000
  fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
  await app.deliverGitHubEvents()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(fetchSpy.mock.calls[1]![1]!.body).toBe(firstAttempt.body)
  expect(fetchSpy.mock.calls[1]![1]!.headers).toEqual(firstAttempt.headers)
  expect(new Headers(firstAttempt.headers).get("idempotency-key"))
    .toBe(`comment-91:review_comments:42:17:${subscription.id}`)
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
  expect(app.database.wasDelivered(subscription.id, "comment-91", "review_comments")).toBe(true)
  expect(await (await send(app)).json()).toMatchObject({ queued: 0 })
  await app.deliverGitHubEvents()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

test("blocked shared-webhook subscriptions preserve FIFO and can recover through a replacement URL", async () => {
  const app = bridge()
  const blocked = subscribe(app)
  const healthy = subscribe(app, "T-healthy")
  const attempts: Array<{ target: string; delivery: string; url: string }> = []
  let recovered = false
  spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    const payload = JSON.parse(String(init?.body))
    attempts.push({ target: payload.targetThreadID, delivery: payload.deliveryId, url: String(url) })
    return new Response(null, { status: payload.targetThreadID === "T-target" && !recovered ? 404 : 202 })
  }) as typeof fetch)
  await send(app)
  await send(app, "comment-92", 92)
  await app.deliverGitHubEvents()
  expect(attempts.map(({ target, delivery }) => `${target}:${delivery}`))
    .toEqual(["T-target:comment-91", "T-healthy:comment-91", "T-healthy:comment-92"])
  expect(app.database.githubDeliveryStatus(blocked.id).pending).toBe(2)
  expect(app.database.githubDeliveryStatus(healthy.id).pending).toBe(0)

  const replacement = app.database.upsert({ ...blocked, webhookUrl: "https://hooks.example.test/replacement" })
  expect(replacement.id).toBe(blocked.id)
  recovered = true
  await app.deliverGitHubEvents() // URL update bypasses the old endpoint's backoff.
  expect(attempts.slice(3)).toEqual([
    { target: "T-target", delivery: "comment-91", url: "https://hooks.example.test/replacement" },
    { target: "T-target", delivery: "comment-92", url: "https://hooks.example.test/replacement" },
  ])
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
})

test("replacing a webhook during an in-flight failure does not delay recovery", async () => {
  const app = bridge()
  const subscription = subscribe(app)
  const response = Promise.withResolvers<Response>()
  const fetchSpy = spyOn(globalThis, "fetch")
    .mockReturnValueOnce(response.promise)
    .mockResolvedValue(new Response(null, { status: 202 }))
  await send(app)
  const running = app.deliverGitHubEvents()
  app.database.upsert({ ...subscription, webhookUrl: "https://hooks.example.test/replacement" })
  response.resolve(new Response(null, { status: 404, headers: { "retry-after": "3600" } }))
  await running
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(fetchSpy.mock.calls[1]![0]).toBe("https://hooks.example.test/replacement")
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
})

test.each(["120", "Wed, 09 Sep 2026 06:49:00 GMT"])("respects Retry-After %s and its boundary", async (retryAfter) => {
  const app = bridge()
  subscribe(app)
  let now = Date.parse("2026-09-09T06:47:00Z")
  spyOn(Date, "now").mockImplementation(() => now)
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
    status: 429, headers: { "retry-after": retryAfter },
  }))
  await send(app)
  await app.deliverGitHubEvents()
  now += 119_999
  await app.deliverGitHubEvents()
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  now += 1
  fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
  await app.deliverGitHubEvents()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
})

test("network errors back off without consuming events or exposing exception secrets", async () => {
  const app = bridge()
  const subscription = subscribe(app)
  let now = Date.now()
  spyOn(Date, "now").mockImplementation(() => now)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret-capability"))
  await send(app)
  await app.deliverGitHubEvents()
  expect(app.database.githubDeliveryStatus(subscription.id)).toMatchObject({ pending: 1, attempts: 1, lastHttpStatus: null })
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-capability")
  now += 60_000
  await app.deliverGitHubEvents()
  expect(app.database.githubDeliveryStatus(subscription.id).attempts).toBe(2)
  now += 119_999
  await app.deliverGitHubEvents()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  now += 1
  fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
  await app.deliverGitHubEvents()
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
})

test("overlapping workers and duplicate arrivals cannot forward a queued event twice", async () => {
  const app = bridge()
  subscribe(app)
  const response = Promise.withResolvers<Response>()
  const fetchSpy = spyOn(globalThis, "fetch").mockReturnValue(response.promise)
  await send(app)
  const running = app.deliverGitHubEvents()
  await app.deliverGitHubEvents()
  expect(await (await send(app)).json()).toMatchObject({ queued: 0 })
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  response.resolve(new Response(null, { status: 202 }))
  await running
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
})

test.each([202, 404])("unsubscribing during an in-flight response (%i) cancels queued work without resurrection", async (status) => {
  const app = bridge()
  const subscription = subscribe(app)
  const response = Promise.withResolvers<Response>()
  const fetchSpy = spyOn(globalThis, "fetch").mockReturnValue(response.promise)
  await send(app)
  await send(app, "comment-92", 92)
  const running = app.deliverGitHubEvents()
  expect(app.database.delete("T-other", subscription.id)).toBe(false)
  expect(app.database.delete("T-target", subscription.id)).toBe(true)
  response.resolve(new Response(null, { status }))
  await running
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
  expect(app.database.list("T-target")).toEqual([])
  expect(app.database.wasDelivered(subscription.id, "comment-91", "review_comments")).toBe(false)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test("a failed fan-out transaction cannot acknowledge or retain a partial enqueue", async () => {
  const app = bridge()
  subscribe(app)
  subscribe(app, "T-other")
  const enqueue = app.database.enqueueGitHubDelivery.bind(app.database)
  let calls = 0
  spyOn(app.database, "enqueueGitHubDelivery").mockImplementation((...args) => {
    if (++calls === 2) throw new Error("disk full")
    return enqueue(...args)
  })
  await expect(send(app)).rejects.toThrow("disk full")
  expect(app.database.pendingGitHubDeliveryCount()).toBe(0)
})

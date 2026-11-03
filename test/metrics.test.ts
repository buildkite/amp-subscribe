import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createSubscriptionBridge } from "../src/app"
import { hmacSha256 } from "../src/crypto"

const config = {
  databasePath: ":memory:", buildkiteWebhookSecret: "buildkite-secret", buildkiteAllowedOrganizations: ["buildkite"],
  allowedWebhookHosts: ["example.test"],
  authenticate: async (request: Request) => {
    if (request.headers.get("authorization") !== "Bearer oidc-token") throw new Error("unauthorized")
    return { threadId: "T-test", workspaceId: "W-test", projectId: "P-test", userId: "U-test" }
  },
}
const openBridges: ReturnType<typeof createSubscriptionBridge>[] = []
afterEach(() => {
  for (const bridge of openBridges.splice(0)) bridge.database.close()
  mock.restore()
})
function bridge() {
  const instance = createSubscriptionBridge({ ...config, fetchFeed: async () => ({
    feed: { title: "Status", entries: [] }, etag: null, lastModified: null,
  }) })
  openBridges.push(instance)
  return instance
}
function apiRequest(path: string, body: unknown, method = "POST") {
  return new Request(`https://bridge.test${path}`, {
    method, headers: { authorization: "Bearer oidc-token" }, body: JSON.stringify(body),
  })
}

describe("metrics", () => {
  test("exposes zeroed remaining counters and gauges without GitHub series", async () => {
    const text = await bridge().metrics().text()
    expect(text).toContain("amp_subscribe_feed_subscriptions 0")
    expect(text).toContain("amp_subscribe_buildkite_subscriptions 0")
    for (const source of ["feed", "buildkite"]) for (const binding of ["legacy", "thread_v1"]) {
      expect(text).toContain(`amp_subscribe_webhook_bindings{binding="${binding}",source="${source}"} 0`)
    }
    expect(text).toContain('amp_subscribe_buildkite_webhook_deliveries_total{outcome="delivered"} 0')
    expect(text).toContain("amp_subscribe_buildkite_webhook_signature_failures_total 0")
    expect(text).not.toContain('source="github"')
    expect(text).not.toContain("amp_subscribe_subscriptions")
    expect(text).not.toContain("amp_subscribe_webhook_events_")
    expect(text).not.toContain("amp_subscribe_webhook_deliveries_total")
    expect(text).not.toContain("amp_subscribe_webhook_signature_failures_total")
  })

  test("binding gauges track current state, including old-client regressions and deletion", async () => {
    const app = bridge()
    const webhookUrl = "https://hooks.example.test/shared"
    const buildkiteInput = { organization: "buildkite", pipeline: "amp-subscribe", webhookUrl, events: ["build.finished"], behavior: "notify" }
    const feedInput = { feedUrl: "https://status.example/feed", webhookUrl, behavior: "notify" }
    const register = async (binding?: string) => {
      expect((await app.fetch(apiRequest("/api/buildkite-subscriptions", { ...buildkiteInput, webhookBinding: binding }))).status).toBe(201)
      expect((await app.fetch(apiRequest("/api/feed-subscriptions", { ...feedInput, webhookBinding: binding }))).status).toBe(201)
    }
    const checkBindings = async (binding: string, count: number) => {
      const text = await app.metrics().text()
      for (const source of ["feed", "buildkite"]) {
        expect(text).toContain(`amp_subscribe_webhook_bindings{binding="${binding}",source="${source}"} ${count}`)
      }
    }
    await register()
    await checkBindings("legacy", 1)
    for (let reload = 0; reload < 2; reload += 1) {
      expect((await app.fetch(apiRequest("/api/webhook", { webhookUrl: "https://hooks.example.test/thread", webhookBinding: "thread_v1" }, "PUT"))).status).toBe(204)
    }
    await checkBindings("legacy", 0)
    await checkBindings("thread_v1", 1)
    await register()
    await checkBindings("legacy", 1)
    await checkBindings("thread_v1", 0)
    await register("thread_v1")
    expect((await app.fetch(apiRequest("/api/webhook", { webhookUrl }, "PUT"))).status).toBe(204)
    await checkBindings("legacy", 1)
    for (const row of app.database.listBuildkite("T-test")) app.database.deleteBuildkite("T-test", row.id)
    for (const row of app.database.listFeeds("T-test")) app.database.deleteFeed("T-test", row.id)
    await checkBindings("legacy", 0)
    await checkBindings("thread_v1", 0)
  })

  test("counts Buildkite subscription, signature, and delivery outcomes", async () => {
    const app = bridge()
    await app.fetch(apiRequest("/api/buildkite-subscriptions", {
      organization: "buildkite", pipeline: "amp-subscribe", webhookUrl: "https://hooks.example.test/secret",
      events: ["build.finished"], behavior: "investigate",
    }))
    expect((await app.fetch(new Request("https://bridge.test/buildkite/webhook", { method: "POST", body: "{}" }))).status).toBe(401)
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }))
    const body = JSON.stringify({ event: "build.finished", pipeline: {
      id: "849411f9-9e6d-4739-a0d8-e247088e9b52", slug: "amp-subscribe", web_url: "https://buildkite.com/buildkite/amp-subscribe",
    }, build: {
      id: "f62a1b4d-10f9-4790-bc1c-e2c3a0c80983", number: 42, state: "passed", blocked: false,
      branch: "main", web_url: "https://buildkite.com/buildkite/amp-subscribe/builds/42", finished_at: "2026-09-21T09:05:00.000Z",
    } })
    const timestamp = Math.floor(Date.now() / 1_000)
    const signature = (await hmacSha256("buildkite-secret", `${timestamp}.${body}`)).slice("sha256=".length)
    expect((await app.fetch(new Request("https://bridge.test/buildkite/webhook", {
      method: "POST", body, headers: { "x-buildkite-event": "build.finished", "x-buildkite-signature": `timestamp=${timestamp},signature=${signature}` },
    }))).status).toBe(202)
    const text = await app.metrics().text()
    expect(text).toContain("amp_subscribe_buildkite_subscriptions 1")
    expect(text).toContain("amp_subscribe_buildkite_webhook_signature_failures_total 1")
    expect(text).toContain('amp_subscribe_buildkite_webhook_events_received_total{event="build.finished"} 1')
    expect(text).toContain('amp_subscribe_buildkite_webhook_deliveries_total{outcome="delivered"} 1')
    expect(text).toContain('amp_subscribe_api_requests_total{method="POST",route="buildkite-subscriptions",status="201"} 1')
  })

  test("counts feed poll outcomes", async () => {
    const app = bridge()
    expect((await app.fetch(apiRequest("/api/feed-subscriptions", {
      feedUrl: "https://status.example/feed.atom", webhookUrl: "https://hooks.example.test/secret", behavior: "notify",
    }))).status).toBe(201)
    await app.pollFeeds()
    const text = await app.metrics().text()
    expect(text).toContain("amp_subscribe_feed_subscriptions 1")
    expect(text).toContain('amp_subscribe_feed_poll_total{result="checked"} 1')
  })
})

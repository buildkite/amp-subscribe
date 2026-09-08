import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createSubscriptionBridge } from "../src/app"
import { hmacSha256 } from "../src/crypto"

const config = {
  databasePath: ":memory:",
  githubWebhookSecret: "github-secret",
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
  const instance = createSubscriptionBridge(config)
  openBridges.push(instance)
  return instance
}

function apiRequest(body: unknown, method = "POST") {
  return new Request("https://bridge.test/api/subscriptions", {
    method,
    headers: { authorization: "Bearer oidc-token", "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  })
}

describe("metrics", () => {
  test("exposes zeroed counters and gauges before any traffic", async () => {
    const text = await bridge().metrics().text()
    expect(text).toContain("# TYPE amp_subscribe_subscriptions gauge")
    expect(text).toContain('amp_subscribe_subscriptions{target_type="pull_request"} 0')
    expect(text).toContain('amp_subscribe_subscriptions{target_type="branch"} 0')
    expect(text).toContain('amp_subscribe_subscriptions{target_type="repository"} 0')
    expect(text).toContain("amp_subscribe_feed_subscriptions 0")
    expect(text).toContain('amp_subscribe_webhook_deliveries_total{outcome="delivered"} 0')
    expect(text).toContain("amp_subscribe_webhook_signature_failures_total 0")
  })

  test("reflects current subscription counts by target type", async () => {
    const app = bridge()
    await app.fetch(apiRequest({
      repository: "lox/project",
      pullRequestNumber: 17,
      webhookUrl: "https://hooks.example.test/secret-capability",
      events: ["reviews"],
      behavior: "investigate",
    }))
    await app.fetch(apiRequest({
      repository: "lox/project",
      targetType: "branch",
      branch: "main",
      webhookUrl: "https://hooks.example.test/secret-capability",
      events: ["commits"],
      behavior: "notify",
    }))
    const text = await app.metrics().text()
    expect(text).toContain('amp_subscribe_subscriptions{target_type="pull_request"} 1')
    expect(text).toContain('amp_subscribe_subscriptions{target_type="branch"} 1')
    expect(text).toContain('amp_subscribe_subscriptions{target_type="repository"} 0')
  })

  test("counts a rejected signature and a delivered webhook event", async () => {
    const app = bridge()
    await app.fetch(apiRequest({
      repository: "lox/project",
      pullRequestNumber: 17,
      webhookUrl: "https://hooks.example.test/secret-capability",
      events: ["reviews"],
      behavior: "investigate",
    }))
    await app.fetch(new Request("https://bridge.test/github/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=bad", "x-github-event": "pull_request", "x-github-delivery": "d0" },
      body: "{}",
    }))

    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }))
    const body = JSON.stringify({
      action: "submitted",
      repository: { id: 42, full_name: "lox/project" },
      pull_request: { number: 17, html_url: "https://github.com/lox/project/pull/17" },
      sender: { login: "reviewer" },
      review: {
        id: 91,
        html_url: "https://github.com/lox/project/pull/17#pullrequestreview-91",
        state: "approved",
        user: { login: "reviewer" },
      },
    })
    await app.fetch(new Request("https://bridge.test/github/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": await hmacSha256("github-secret", body),
        "x-github-event": "pull_request_review",
        "x-github-delivery": "d1",
      },
      body,
    }))

    const text = await app.metrics().text()
    expect(text).toContain("amp_subscribe_webhook_signature_failures_total 1")
    expect(text).toContain('amp_subscribe_webhook_events_received_total{event="pull_request_review"} 1')
    expect(text).toContain('amp_subscribe_webhook_deliveries_total{outcome="delivered"} 1')
    expect(text).toContain('amp_subscribe_api_requests_total{method="POST",route="subscriptions",status="201"} 1')
  })

  test("labels suppressed events by suppression reason", async () => {
    const app = bridge()
    await app.fetch(apiRequest({
      repository: "lox/project",
      pullRequestNumber: 17,
      webhookUrl: "https://hooks.example.test/secret-capability",
      events: ["checks"],
      behavior: "investigate",
    }))
    const body = JSON.stringify({
      action: "queued",
      repository: { id: 42, full_name: "lox/project" },
      check_run: { id: 94, status: "queued", conclusion: null, head_sha: "a".repeat(40), pull_requests: [{ number: 17 }] },
    })
    await app.fetch(new Request("https://bridge.test/github/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": await hmacSha256("github-secret", body),
        "x-github-event": "check_run",
        "x-github-delivery": "d-queued",
      },
      body,
    }))
    const text = await app.metrics().text()
    expect(text).toContain('amp_subscribe_webhook_events_suppressed_total{reason="check_lifecycle"} 1')
  })

  test("counts feed poll outcomes", async () => {
    const app = createSubscriptionBridge({
      ...config,
      fetchFeed: async () => ({
        feed: {
          title: "Service status",
          entries: [{
            id: "incident-1",
            fingerprint: "version-1",
            title: "Queue delays",
            url: "https://status.example/incidents/1",
            publishedAt: null,
            updatedAt: null,
          }],
        },
        etag: null,
        lastModified: null,
      }),
    })
    openBridges.push(app)
    await app.fetch(new Request("https://bridge.test/api/feed-subscriptions", {
      method: "POST",
      headers: { authorization: "Bearer oidc-token", "content-type": "application/json" },
      body: JSON.stringify({
        feedUrl: "https://status.example/feed.atom",
        webhookUrl: "https://hooks.example.test/secret-capability",
        behavior: "notify",
      }),
    }))
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }))
    await app.pollFeeds()
    const text = await app.metrics().text()
    expect(text).toContain('amp_subscribe_feed_subscriptions 1')
    expect(text).toContain('amp_subscribe_feed_poll_total{result="checked"} 1')
  })
})

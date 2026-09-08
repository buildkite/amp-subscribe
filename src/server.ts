import { createSubscriptionBridge } from "./app"
import { createOidcAuthenticator } from "./auth"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const port = Number(process.env.PORT ?? "3000")
const feedPollSeconds = Number(process.env.FEED_POLL_INTERVAL_SECONDS ?? "300")
if (!Number.isFinite(feedPollSeconds) || feedPollSeconds < 30) {
  throw new Error("FEED_POLL_INTERVAL_SECONDS must be at least 30")
}
const values = (name: string) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean)
const bridge = createSubscriptionBridge({
  databasePath: process.env.DATABASE_PATH ?? "./data/relay.sqlite",
  githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  allowedWebhookHosts: required("AMP_WEBHOOK_ALLOWED_HOSTS").split(",").map((host) => host.trim().toLowerCase()),
  authenticate: createOidcAuthenticator({
    audience: required("AMP_OIDC_AUDIENCE").split(",").map((audience) => audience.trim()).filter(Boolean),
    allowedWorkspaceIds: values("AMP_ALLOWED_WORKSPACE_IDS"),
    allowedProjectIds: values("AMP_ALLOWED_PROJECT_IDS"),
    allowedUserIds: values("AMP_ALLOWED_USER_IDS"),
  }),
})

Bun.serve({
  port,
  fetch: bridge.fetch,
})

console.log(`amp-subscribe listening on port ${port}`)

const metricsPort = Number(process.env.METRICS_PORT ?? "9091")
Bun.serve({
  port: metricsPort,
  fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/metrics") return bridge.metrics()
    return new Response("not found", { status: 404 })
  },
})

console.log(`amp-subscribe metrics listening on port ${metricsPort}`)

const pollFeeds = () => bridge.pollFeeds().then((result) => {
  if (result.failed > 0) console.error("Feed poll completed with failures", result)
}).catch((error) => console.error("Feed poll failed", error))
void pollFeeds()
setInterval(pollFeeds, feedPollSeconds * 1_000).unref()

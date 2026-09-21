import { hmacSha256, timingSafeEqual } from "./crypto"
import { buildkiteEvents, type BuildkiteEvent, type RoutedBuildkiteEvent } from "./types"

type JsonObject = Record<string, unknown>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const slugPattern = /^[a-z0-9][a-z0-9-]{0,99}$/
const buildStates = [
  "scheduled", "running", "failing", "passed", "failed", "blocked", "canceled", "canceling", "skipped", "not_run",
  "waiting", "waiting_failed",
] as const

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function string(value: unknown, pattern: RegExp, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum && pattern.test(value) ? value : null
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) return null
  return value
}

function buildkiteTarget(value: unknown): { organization: string; pipeline: string } | null {
  if (typeof value !== "string" || value.length > 2_048) return null
  try {
    const url = new URL(value)
    const parts = url.pathname.split("/").filter(Boolean)
    if (url.protocol !== "https:" || url.hostname !== "buildkite.com" || url.port || url.username || url.password
      || parts.length !== 2 || !slugPattern.test(parts[0]!) || !slugPattern.test(parts[1]!)) return null
    return { organization: parts[0]!, pipeline: parts[1]! }
  } catch {
    return null
  }
}

export function normalizeBuildkiteEvent(eventName: string, deliveryId: string, payload: unknown): RoutedBuildkiteEvent | null {
  if (!buildkiteEvents.includes(eventName as BuildkiteEvent) || !/^[a-f0-9]{64}$/.test(deliveryId)) return null
  const root = object(payload)
  const pipeline = object(root?.pipeline)
  const build = object(root?.build)
  if (!root || !pipeline || !build || root.event !== eventName) return null

  const pipelineId = string(pipeline.id, uuidPattern, 36)
  const pipelineSlug = string(pipeline.slug, slugPattern, 100)
  const target = buildkiteTarget(pipeline.web_url)
  const buildId = string(build.id, uuidPattern, 36)
  const number = typeof build.number === "number" && Number.isSafeInteger(build.number) && build.number > 0
    ? build.number : null
  const state = typeof build.state === "string" && buildStates.includes(build.state as (typeof buildStates)[number])
    ? build.state as (typeof buildStates)[number] : null
  const branch = string(build.branch, /^[^\u0000-\u001f\u007f\u2028\u2029]{1,255}$/, 255)
  const blocked = typeof build.blocked === "boolean" ? build.blocked : null
  if (!pipelineId || !pipelineSlug || !target || pipelineSlug !== target.pipeline || !buildId || !number || !state
    || !branch || blocked === null) return null
  const buildUrl = `https://buildkite.com/${target.organization}/${target.pipeline}/builds/${number}`
  if (build.web_url !== buildUrl) return null

  const eventTimeKey = eventName === "build.scheduled" ? "scheduled_at"
    : eventName === "build.running" ? "started_at"
      : eventName === "build.failing" ? "failing_at" : "finished_at"
  const occurredAt = timestamp(build[eventTimeKey]) ?? timestamp(build.created_at)
  if (!occurredAt) return null
  const commit = string(build.commit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 64)

  return {
    schemaVersion: 1,
    source: "buildkite",
    deliveryId,
    event: eventName as BuildkiteEvent,
    organization: target.organization,
    pipeline: { id: pipelineId, slug: pipelineSlug, url: `https://buildkite.com/${target.organization}/${target.pipeline}` },
    build: {
      id: buildId,
      number,
      state,
      blocked,
      branch,
      url: buildUrl,
      ...(commit ? { commit } : {}),
    },
    occurredAt,
  }
}

export async function verifyBuildkiteSignature(
  secret: string,
  body: Uint8Array,
  header: string,
  now = Date.now(),
): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2)))
  const timestamp = parts.timestamp
  const signature = parts.signature
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false
  if (Math.abs(now - Number(timestamp) * 1_000) > 5 * 60 * 1_000) return false
  const message = `${timestamp}.${new TextDecoder().decode(body)}`
  const expected = (await hmacSha256(secret, message)).slice("sha256=".length)
  return timingSafeEqual(expected, signature.toLowerCase())
}

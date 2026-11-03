export type SubscriptionBehavior = "notify" | "investigate" | "implement"
export type SubscriptionDeliveryMode = "automatic" | "queue" | "steer"
export type WebhookBinding = "legacy" | "thread_v1"

export const buildkiteEvents = [
  "build.scheduled",
  "build.running",
  "build.failing",
  "build.finished",
  "build.skipped",
] as const

export type BuildkiteEvent = (typeof buildkiteEvents)[number]

export interface BuildkiteSubscription {
  id: string
  threadId: string
  organization: string
  pipeline: string
  branch?: string
  commit?: string
  webhookUrl: string
  webhookBinding: WebhookBinding
  events: BuildkiteEvent[]
  behavior: SubscriptionBehavior
  deliveryMode: SubscriptionDeliveryMode
  createdAt: string
}

export interface RoutedBuildkiteEvent {
  schemaVersion: 1
  source: "buildkite"
  deliveryId: string
  event: BuildkiteEvent
  organization: string
  pipeline: {
    id: string
    slug: string
    url: string
  }
  build: {
    id: string
    number: number
    state: "scheduled" | "running" | "failing" | "passed" | "failed" | "blocked" | "canceled" | "canceling" | "skipped" | "not_run" | "waiting" | "waiting_failed"
    blocked: boolean
    branch: string
    url: string
    commit?: string
  }
  occurredAt: string
}

export interface FeedSubscription {
  id: string
  threadId: string
  feedUrl: string
  webhookUrl: string
  webhookBinding: WebhookBinding
  behavior: SubscriptionBehavior
  etag: string | null
  lastModified: string | null
  createdAt: string
}

export interface FeedEntry {
  id: string
  fingerprint: string
  title: string | null
  url: string | null
  publishedAt: string | null
  updatedAt: string | null
}

export interface ParsedFeed {
  title: string | null
  entries: FeedEntry[]
}

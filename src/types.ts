export const subscriptionEvents = [
  "pull_requests",
  "issues",
  "commits",
  "reviews",
  "review_comments",
  "discussion_comments",
  "checks",
  "merged",
  "closed",
] as const

export type SubscriptionEvent = (typeof subscriptionEvents)[number]
export type SubscriptionBehavior = "notify" | "investigate" | "implement"
export type WebhookBinding = "legacy" | "thread_v1"

export const checkStatuses = ["requested", "waiting", "pending", "queued", "in_progress", "completed"] as const
export const checkConclusions = [
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
] as const
export type CheckStatus = (typeof checkStatuses)[number]
export type CheckConclusion = (typeof checkConclusions)[number]

export type RoutedEventDetail =
  | {
      kind: "pull_request"
      state?: "open" | "closed"
      draft?: boolean
      merged?: boolean
      headSha?: string
      beforeSha?: string
      afterSha?: string
      changedFields?: Array<"body" | "title" | "base">
      requestedReviewer?: string
      requestedTeam?: string
      assignee?: string
    }
  | {
      kind: "push"
      beforeSha?: string
      afterSha?: string
      forced?: boolean
      created?: boolean
      deleted?: boolean
    }
  | {
      kind: "pull_request_review"
      id: number
      url: string
      state?: "approved" | "changes_requested" | "commented" | "dismissed" | "pending"
      author?: string
      commitSha?: string
    }
  | {
      kind: "pull_request_review_comment"
      id: number
      url: string
      author?: string
      reviewId?: number
      inReplyToId?: number
      commitSha?: string
      line?: number
      startLine?: number
      side?: "LEFT" | "RIGHT"
    }
  | {
      kind: "issue_comment"
      id: number
      url: string
      author?: string
    }
  | {
      kind: "check_run"
      id: number
      url?: string
      status?: CheckStatus
      conclusion?: CheckConclusion | null
      headSha?: string
      appSlug?: string
    }
  | {
      kind: "check_suite"
      id: number
      apiPath: string
      status?: CheckStatus
      conclusion?: CheckConclusion | null
      headSha?: string
      appSlug?: string
    }
  | {
      kind: "workflow_run"
      id: number
      url?: string
      status?: CheckStatus
      conclusion?: CheckConclusion | null
      triggerEvent?: string
      runAttempt?: number
      headSha?: string
    }

interface SubscriptionBase {
  id: string
  threadId: string
  repository: string
  webhookUrl: string
  webhookBinding: WebhookBinding
  events: SubscriptionEvent[]
  behavior: SubscriptionBehavior
  createdAt: string
}

export type Subscription = SubscriptionBase & (
  | { targetType: "pull_request"; pullRequestNumber: number }
  | { targetType: "branch"; branch: string }
  | { targetType: "repository" }
)

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

interface RoutedEventBase {
  schemaVersion: 1
  deliveryId: string
  githubEvent: string
  event: SubscriptionEvent
  action: string
  repository: {
    id: number
    fullName: string
  }
  sender: string | null
  occurredAt: string
  detail?: RoutedEventDetail
}

export type RoutedEvent = RoutedEventBase & (
  | { targetType: "pull_request"; pullRequest: { number: number; url: string; headSha?: string } }
  | { targetType: "branch"; branch: { name: string; url: string } }
  | {
      targetType: "repository"
      subject: { kind: "pull_request" | "issue"; number: number; url: string }
    }
)

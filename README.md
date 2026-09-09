# amp-subscribe

amp-subscribe wakes up an Amp thread when something it cares about happens.

Tell Amp to watch a pull request, then move on. If CI fails, a reviewer comments, or the PR is
merged, the event returns to the same thread. Amp still has the context behind the work, so it can
notify you, investigate the change, or prepare a fix.

```text
You: Watch https://github.com/acme/widgets/pull/123 and investigate CI failures.
Amp: Subscribed this thread to acme/widgets#123.

...later, while the thread is idle...

GitHub: A check failed on acme/widgets#123.
Amp: The Linux test job failed because...
```

GitHub repositories, pull requests, and branches, plus RSS and Atom feeds, are supported today. The
bridge is designed to support other event sources, such as Slack, in the future.

## Why use it?

- **Hand work off and move on.** You do not need to keep checking a PR or wake the thread manually.
- **Keep the useful context.** Reviews and failures return to the thread that understands the work.
- **Choose how Amp responds.** It can only notify you, investigate the event, or make a local fix.
- **Watch long-running work.** A thread can follow new work in a repository, a PR, `main`, or a release branch while idle.

## Quick start

You need a running amp-subscribe bridge and its GitHub App installed on the repositories you want to
watch. To run your own bridge, see [Self-hosting](#self-hosting).

1. Install [`plugin/subscribe.ts`](plugin/subscribe.ts) as
   `.amp/plugins/subscribe.ts` for one project or
   `~/.config/amp/plugins/subscribe.ts` for every project.
2. Configure the plugin with your bridge URL and OIDC audience. These commands make the settings
   available to plugins installed in either location:

   ```sh
   printf %s https://your-bridge.example | \
     amp secrets set AMP_SUBSCRIBE_URL --user --env --data-file -
   printf %s urn:your-org:amp-subscribe | \
     amp secrets set AMP_SUBSCRIBE_AUDIENCE --user --env --data-file -
   ```

3. Run `amp orb restart-processes` to load the new environment, then run `plugins: reload` from
   Amp's command palette. You can now ask Amp:

   ```text
   Subscribe this thread to https://github.com/owner/repo/pull/123.
   Investigate reviews and CI failures.
   ```

   Or watch a branch:

   ```text
   Subscribe this thread to the main branch of owner/repo.
   Notify me about pushes and CI failures.
   ```

   Or watch for new pull requests and issues in a repository:

   ```text
   Subscribe this thread to new pull requests and issues in owner/repo.
   ```

   Repository subscriptions report only newly opened pull requests and issues; later activity can
   be followed with a pull request subscription.

   Or subscribe to a feed:

   ```text
   Subscribe this thread to https://namespace-status.com/feed.atom and notify me about updates.
   ```

   Both RSS and Atom feeds are accepted. Existing entries establish the initial baseline; the
   thread wakes only for entries added or updated after subscription.

Keep the plugin filename `subscribe.ts` when upgrading. Amp includes the plugin identity in its
durable webhook URLs, so renaming it would disconnect existing subscriptions.

When upgrading from a version that does not include an authenticated target thread in forwarded
events, deploy the bridge before updating the plugin. The bridge field is additive, so the old
plugin tolerates it; the updated plugin rejects events without it rather than risk appending them to
the wrong thread. Existing subscription rows already contain the required thread ID and do not need
to be recreated.

When migrating from `github-relay.ts`, remove the old plugin and recreate its subscriptions after
installing `subscribe.ts`.

### Response modes

- `notify`: report what happened without changing anything.
- `investigate` (default): inspect and explain the event without changing external state.
- `implement`: make and verify local changes, but do not push without permission.

When Amp creates a PR directly with `gh pr create`, the plugin automatically watches commits,
reviews, comments, checks, merge, and close events in `investigate` mode. Explicit subscriptions
still default to every supported event. You can also ask Amp to list or remove this thread's
subscriptions.

## How it works

```text
GitHub App ──webhook──┐
                     ├──▶ amp-subscribe ──durable webhook──▶ Amp thread
RSS/Atom ───poll──────┘          ▲                                │
                                └──────── subscription ──────────┘
```

The plugin creates a durable webhook and registers what the current thread wants to watch. Amp can
share one plugin webhook registration across several project threads owned by the same user, so the
bridge stores the authenticated subscribing thread ID with each subscription. amp-subscribe
verifies matching GitHub events, adds that trusted target thread ID to a small event summary, and
stores it in a SQLite delivery queue before replying HTTP 202 to GitHub. A worker forwards queued
events to the webhook. The plugin validates the ID and looks up the target thread explicitly.
Feed events use the same target-thread routing contract.

An asleep orb can be woken by Amp, but an **archived owner of a shared webhook** can make Amp reject
the request with HTTP 404 before the plugin runs, even when the subscribing thread is active.
The bridge cannot reassign that owner: the public plugin API returns a shared capability URL, not
an ownership-transfer API. See [Recovering failed deliveries](#recovering-failed-deliveries).

For feeds, the bridge polls public HTTPS URLs every five minutes by default. Set
`FEED_POLL_INTERVAL_SECONDS` to change the interval (minimum 30 seconds). Conditional requests are
used when feeds provide ETag or Last-Modified headers.

The bridge drops queued and in-progress check lifecycle events before they consume durable webhook
capacity. The plugin immediately queues terminal failures, but routine events do not steer active
work. For pull requests, a successful check triggers an authenticated `gh` lookup: the plugin
suppresses stale and still-pending results, then reports at most once per head after every check in
GitHub's current status rollup has passed. Branch check successes retain short-window batching. The
plugin also batches review submissions with their line comments, queues agent-authored comment
replies without steering active work, and suppresses pull request body/title edits. Plugin
logs include delivery reasons, steering decisions, and cumulative received/delivered/suppressed/
batched counts.

GitHub delivery IDs are deduplicated durably while queued and after successful forwarding. Failed
deliveries retain their original payload and idempotency key across process restarts. A single
worker checks for work every second, with at most 100 attempts per pass and a 10-second timeout per
attempt. Failures back off from one minute to one hour, respecting a longer `Retry-After`. Pending
events preserve arrival order within each subscription; other subscriptions can progress while one
backs off. This preserves arrival order, not GitHub's event-generation order. Retries continue until
Amp accepts the event or the user explicitly unsubscribes. Delivery is at-least-once, not exactly-once.
Queued events keep the target thread and behavior captured at arrival; re-registering changes their
destination webhook URL, not their stored payload.

The GitHub HTTP 202 response now reports `queued` (newly persisted subscription deliveries), not
`delivered`/`removed`. `matchedEvents` counts normalized events, **not matching subscriptions**.
GitHub does [not automatically retry failed webhooks](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries);
the bridge's queue handles failures after persistence, but cannot recover events that never reached
the bridge or could not be committed to its database.

Thread-side batching and the short semantic event cache are process-local. Before appending a
GitHub message, the plugin also reads the target thread's recent transcript and suppresses an exact
content match among user messages after
the latest assistant message. This catches a retry or restarted handler when the same generated
message is already stacked for the agent, while allowing changed check or review details and an
update that the agent previously handled. The read covers the 20 most recent user/assistant
messages, the maximum supported by one plugin API call.

This pending-message check is entirely plugin-side; it does not change the bridge payload or API.
Deploying the bridge is therefore unnecessary, and mixed installations are safe while the updated
`subscribe.ts` plugin rolls out.

## Recovering failed deliveries

The bridge no longer deletes GitHub or feed subscriptions on HTTP errors, including 404 and 410.
It cannot know from those statuses whether a shared webhook's owner is recoverable. Permanent
failures therefore require operator attention or an explicit unsubscribe; they do not silently
discard queued GitHub events. Feed polling retries unseen entries on the next poll without advancing
its cache validators after a delivery failure. Feeds do not use the GitHub queue: an entry that falls
out of the upstream feed before recovery may still be lost.

1. Ask Amp to list the affected thread's subscriptions. GitHub subscriptions include a `delivery`
   object with the pending count and the oldest pending event's attempt count, last HTTP status,
   last attempt, and next attempt times. A null HTTP status with attempts greater than zero denotes
   a transport error. A null next-attempt time with pending work means it is eligible immediately.
   The `amp_subscribe_pending_github_deliveries` gauge shows the total backlog.
2. For a shared webhook owned by an archived thread, restore that owner with its user's approval,
   or ask Amp support to repair/replace the registration. Reloading alone may return the same shared
   URL. The bridge cannot discover the owner, unarchive it, or elect another thread.
3. If the webhook URL changes, subscribe to the same target again **without unsubscribing first**.
   This updates the URL in place, preserves the subscription ID and backlog, and makes queued events
   eligible immediately. Restoring the original endpoint lets scheduled retries recover automatically.
4. If an older relay already deleted the subscription, recreate it after fixing the webhook and
   manually redeliver the missed events from the GitHub App's **Advanced → Recent deliveries** page.
   The new queue cannot reconstruct historical events that the old version discarded.

Failures emit `webhook_delivery_failed` logs containing the subscription/target thread IDs, exact
HTTP status, webhook URL fingerprint and available request IDs. GitHub logs also include the delivery
ID, Amp idempotency key, attempt and retry time (null if replaced or unsubscribed during the request).
Raw response bodies, capability URLs, cookies and exception messages are deliberately omitted because
they can contain credentials. Use the correlation
IDs with Amp support to determine why its endpoint rejected a request.

Unsubscribing explicitly discards that subscription's pending work and deduplication history; it
cannot cancel an HTTP request already in flight. No automatic expiry or queue-size eviction is used.
Monitor backlog and disk space, and resolve or unsubscribe permanently broken targets.

## Self-hosting

Install [mise](https://mise.jdx.dev/), then:

```sh
mise install
mise exec -- bun install
cp .env.example .env
```

Edit `.env` to set:

- At least one `AMP_ALLOWED_WORKSPACE_IDS`, `AMP_ALLOWED_PROJECT_IDS`, or `AMP_ALLOWED_USER_IDS`
  allowlist.
- `AMP_OIDC_AUDIENCE` to the audience configured in the plugin.
- `AMP_WEBHOOK_ALLOWED_HOSTS` to the host or parent domain used by Amp durable webhooks.

Create the GitHub App with its required events and read-only permissions, and save its generated
webhook secret to `.env`:

```sh
mise run setup-github-app
```

The command asks for the public bridge origin (for example, `https://subscribe.example.com`) and
the GitHub organization that should own the app,
then opens GitHub's App Manifest flow. After creating the app, install it on the repositories you
want to watch. Leave the organization blank to create a personal app. For manual setup, see
[GitHub App setup](docs/github-app.md).

Start the bridge with:

```sh
mise exec -- bun run start
```

Use `GET /healthz` as its health check and keep `DATABASE_PATH` on persistent storage in production.
Run **one bridge process per database**; delivery-worker serialization is process-local. Startup adds
the pending-delivery table without rewriting existing subscriptions or delivery records. Back up the
database before deployment. An older binary does not drain queued work and may again delete failed
subscriptions, so rolling back the binary is not a safe way to preserve a pending backlog.

The bridge exposes Prometheus-format metrics (subscription counts, webhook delivery outcomes, feed poll
results, and more) on `GET /metrics`, served on a separate port (`METRICS_PORT`, default `9091`). On
Fly.io, the included `fly.toml` keeps that port off the public service and configures Fly's
[custom metrics scraping](https://fly.io/docs/reference/metrics/#custom-metrics) to pick it up
automatically. On other hosts, restrict access to the metrics port with your firewall or network
configuration. A ready-to-import Grafana dashboard for these metrics lives in [`dashboards/`](dashboards/README.md).

The included `fly.toml` shows one Fly.io deployment. Before deploying a copy, change its app name,
region, and OIDC audience, then create the app and set its secrets:

```sh
APP=your-amp-subscribe-app
mise exec -- flyctl apps create "$APP"
mise exec -- flyctl secrets set --app "$APP" \
  GITHUB_WEBHOOK_SECRET=... AMP_ALLOWED_WORKSPACE_IDS=...
mise exec -- flyctl deploy --remote-only --app "$APP"
```

## Security

The subscription API authenticates Amp with short-lived workload identity tokens and derives the
thread owner from the signed identity. Forwarded target thread IDs come only from those authenticated
subscription records, not GitHub or feed content. GitHub webhooks are signature-checked, delivery
IDs are deduplicated per subscription, and outbound delivery is restricted to configured HTTPS
hosts.

amp-subscribe forwards bounded event metadata, not untrusted PR titles, comments, check output,
commit messages, patches, or filenames. Amp fetches that content through its normal GitHub tools
when it investigates an event.

Feed downloads are limited to public HTTPS endpoints and 1 MiB. Forwarded feed events contain
bounded entry metadata but not descriptions or body content; the plugin treats feed titles and
linked pages as untrusted data.

## Development

```sh
mise run ci
```

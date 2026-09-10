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

### Upgrade from a shared webhook

Deploy the updated bridge **before** updating the plugin. On startup, the plugin registers
`github-pr-events:<AMP_THREAD_ID>` and calls `PUT /api/webhook` with
`{ "webhookUrl": "...", "webhookBinding": "thread_v1" }`.
The bridge authenticates the orb and atomically moves only that thread's GitHub and feed
subscriptions to the new URL. Subscription IDs, behaviors, event filters, delivery history, and
feed baselines are preserved. Startup adds a `webhook_binding` column to both subscription tables,
defaulting existing rows to `legacy`. Repeated plugin loads use the same key
and safely repeat the update. An older bridge lacks this endpoint, so plugin initialization fails
until the bridge is upgraded and the plugin is reloaded.

Reload the updated plugin in each subscribed thread to migrate it; dormant threads remain on the
old endpoint until their plugin starts. The old shared webhook is not deleted because other threads
may still use it. Do not roll back the plugin in migrated threads: that would restore shared URLs.
Subscriptions already deleted by the old relay must be recreated. Events missed before or during
the transition, including events queued at the old Amp registration, may need manual GitHub
redelivery after migration. This change adds no retry queue or indefinite event retention; existing
HTTP 404/410 removal behavior remains, except that a late response from a replaced URL cannot remove
the migrated subscription. Archiving a subscribing thread can still stop its own notifications.

#### Tracking completion and retiring legacy clients

The plugin declares `webhookBinding: "thread_v1"` on migration and new subscriptions. The bridge
persists it and returns it in subscription lists. Omitted bindings mean `legacy`, including on
updates: an old plugin writing a shared URL clears the migrated marker. This is a client-declared
version, not independent proof of Amp webhook ownership, handler execution, or successful wakeup.

Watch `amp_subscribe_webhook_bindings{binding="legacy"}` for both `source="github"` and
`source="feed"`; [dashboard queries](dashboards/README.md#webhook-migration) are provided. It counts
current subscriptions, not distinct threads or cumulative migrations. All four binding/source series
are emitted even at zero. Missing metrics or an unavailable scrape must not be interpreted as zero.

To identify remaining threads without exposing capability URLs, run this query against a read-only
connection to the bridge's SQLite database:

```sql
SELECT 'github' AS source, id, thread_id, webhook_binding
FROM subscriptions WHERE webhook_binding = 'legacy'
UNION ALL
SELECT 'feed', id, thread_id, webhook_binding
FROM feed_subscriptions WHERE webhook_binding = 'legacy'
ORDER BY thread_id, source, id;
```

Before retiring the old path:

1. Verify a canary thread receives events on its own webhook, including after its orb sleeps/resumes.
2. Reload or explicitly reconcile every remaining legacy thread. Keep legacy compatibility while
   dormant threads still need it. Review `subscription_removed` and `subscription_unsubscribed` logs:
   deletion lowers the gauge too, so zero does not prove every previous subscription migrated.
3. Confirm fresh scrapes stay at zero across the intended instances and account for any events
   queued at old Amp registrations. The bridge cannot inspect or prove those queues are drained.
4. Set `AMP_ALLOW_LEGACY_WEBHOOKS=false` on the bridge to reject legacy/omitted bindings on both
   subscription POST routes and `PUT /api/webhook` with HTTP 409. Watch `legacy_webhook_rejected`
   logs for old clients that need updating before removing legacy code in a later release.

The switch defaults to `true`; it neither deletes old subscriptions nor unregisters Amp webhooks.
There is no automatic deadline for dormant instances. Do not roll back to a pre-tracking backend
while relying on these counts: its updates can change a URL without clearing `thread_v1`. After such
a rollback, re-establish binding state before using the gauge as a retirement signal.

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

The plugin creates **one durable webhook per thread**, shared only by that thread's GitHub and feed
subscriptions. Amp shares registrations for the same user/project/plugin/key, so the key includes
the orb's `AMP_THREAD_ID` instead of using one fixed project-wide key. Registration happens when the
plugin loads, including on orb restart, without waiting for a tool call or session-start event.
Missing thread identity is an error; the plugin does not fall back to a shared key or UI focus.

The bridge stores the authenticated subscribing thread ID, verifies matching GitHub events, and
forwards bounded metadata with that trusted target ID. The handler checks that its registration
owner, orb thread, and payload target all agree, then appends to the owning thread. It never forwards
to another thread. This isolates active subscribers from an unrelated thread's archived webhook
owner. Amp can store events and wake the owning thread while its orb is asleep. Feed events use
the same routing contract.

For feeds, the bridge polls public HTTPS URLs every five minutes by default. Set
`FEED_POLL_INTERVAL_SECONDS` to change the interval (minimum 30 seconds). Conditional requests are
used when feeds provide ETag or Last-Modified headers.

The bridge drops queued and in-progress check lifecycle events before they consume durable webhook
capacity. For Chris Atkins (`catkins-bk`), all GitHub events steer so they are preferred when his
active thread next dequeues work. For other users, the plugin only steers terminal failures;
routine events retain their queued delivery behavior. For pull requests, a successful check
triggers an authenticated `gh` lookup: the plugin
suppresses stale and still-pending results, then reports at most once per head after every check in
GitHub's current status rollup has passed. Branch check successes retain short-window batching. The
plugin also batches review submissions with their line comments, queues agent-authored comment
replies without steering active work, and suppresses pull request body/title edits. Plugin
logs include delivery reasons, steering decisions, and cumulative received/delivered/suppressed/
batched counts.

GitHub delivery IDs are deduplicated durably by the bridge. Thread-side batching and the short
semantic event cache are process-local. Before appending a GitHub message, the plugin also reads the
target thread's recent transcript and suppresses an exact content match among user messages after
the latest assistant message. This catches a retry or restarted handler when the same generated
message is already stacked for the agent, while allowing changed check or review details and an
update that the agent previously handled. The read covers the 20 most recent user/assistant
messages, the maximum supported by one plugin API call.

The pending-message check is plugin-side and does not change the bridge payload. The per-thread
webhook migration does require the bridge update described above.

The current Amp plugin API does not expose whether a thread is snoozed or let this plugin snooze it.
Delivery is therefore not snooze-gated: treating idle state as snoozed could silently discard an
event, while retaining it would require a durable plugin-side retry queue. Threads do not need to
snooze themselves for subscriptions to work.

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

The bridge exposes Prometheus-format metrics (subscription counts, webhook delivery outcomes, feed poll
results, and more) on `GET /metrics`, served on a separate port (`METRICS_PORT`, default `9091`). On
Fly.io, the included `fly.toml` keeps that port off the public service and configures Fly's
[custom metrics scraping](https://fly.io/docs/reference/metrics/#custom-metrics) to pick it up
automatically. On other hosts, restrict access to the metrics port with your firewall or network
configuration. A ready-to-import Grafana dashboard for these metrics lives in [`dashboards/`](dashboards/README.md).

### Diagnosing delivery problems

Bridge stdout/stderr includes structured JSON events:

- `subscription_registered`, `subscription_unsubscribed`: source, authenticated thread ID and
  subscription ID; registration includes the binding version.
- `webhook_binding_updated`: thread ID, binding version, endpoint SHA-256 fingerprint and changed
  GitHub/feed row counts. Repeated startup updates report zero changed rows.
- `legacy_webhook_rejected`: a retired client attempted a legacy binding write.
- `github_webhook_processed`: GitHub delivery GUID, event type, normalized event count, matched
  subscription/event pairs, deduplicated, suppressed, delivered, failed and removed counts. This
  distinguishes zero matches from a retry that was already accepted.
- `webhook_delivery_failed`, `subscription_removed`: subscription/thread IDs, binding version,
  exact HTTP status (or `null` for a transport failure), reason, idempotency key, endpoint host/hash
  and bounded `x-request-id`/`fly-request-id` response headers. These correlate a failed GitHub
  delivery or feed entry with Amp diagnostics without logging capability URLs or response bodies.

An HTTP 2xx counted as `delivered` means Amp accepted the request, not that a message was appended
or the thread woke. For that boundary, use Amp's handler traces: the plugin logs webhook receipt
with the Amp event ID and owner/orb thread IDs, then its existing delivery/suppression decisions.
These plugin logs may be trace span events rather than durable local log files; their absence from
a file is not evidence the handler did not run. Preserve bridge logs externally if you need history
beyond the hosting provider's retention window; deletion still cascades the SQLite delivery ledger.

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

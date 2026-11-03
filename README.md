# amp-subscribe

amp-subscribe wakes up an Amp thread when something it cares about happens.

Tell Amp to watch a Buildkite pipeline or RSS/Atom feed, then move on. Events return to the same
thread, where Amp can notify you, investigate the change, or prepare a local fix.

```text
You: Watch buildkite/my-pipeline and investigate failed builds.
Amp: Subscribed this thread to buildkite/my-pipeline.

...later, while the thread is idle...

Buildkite: Build #123 failed.
Amp: The Linux test job failed because...
```

GitHub events are handled by [Amp's native GitHub listeners](https://ampcode.com/docs/github),
not this service. See [Migrating GitHub subscriptions](#migrating-github-subscriptions).

## Why use it?

- **Hand work off and move on.** You do not need to keep checking builds or wake the thread manually.
- **Keep the useful context.** Build failures and feed updates return to the thread that understands the work.
- **Choose how Amp responds.** It can only notify you, investigate the event, or make a local fix.
- **Watch long-running work.** A thread can follow a pipeline or feed while idle.

## Quick start

You need a running amp-subscribe bridge and the source webhook configured for what you want to watch.
To run your own bridge, see [Self-hosting](#self-hosting).

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
   Subscribe this thread to buildkite/my-pipeline and investigate failed builds.
   ```

   Buildkite subscriptions default to finished and skipped builds. Scheduled, running, and failing
   lifecycle events can be selected explicitly. Investigation requires authenticated Buildkite
   access in the orb, such as the Buildkite MCP server or `bk` CLI.

   Without filters, a Buildkite subscription watches **all branches and commits** in that pipeline.
   To watch CI after pushing, pass the full pushed SHA as `commit` to `buildkite_pipeline_subscribe`.
   An optional `branch` filter matches the exact, case-sensitive branch name; when both filters are
   set, both must match. Re-subscribing to the same pipeline replaces the filters, so update `commit`
   after each push. Omitted filters are cleared. A build URL selects its pipeline, not one build.
   See [Buildkite subscription filters](docs/buildkite.md#subscription-filters) for an example.

   Or subscribe to a feed:

   ```text
   Subscribe this thread to https://namespace-status.com/feed.atom and notify me about updates.
   ```

   Both RSS and Atom feeds are accepted. Existing entries establish the initial baseline; the
   thread wakes only for entries added or updated after subscription.

Keep the plugin filename `subscribe.ts` when upgrading. Amp includes the plugin identity in its
durable webhook URLs, so renaming it would disconnect existing subscriptions.

### Migrating GitHub subscriptions

The GitHub plugin tools, `/api/subscriptions`, and `/github/webhook` have been removed. The old
endpoints return HTTP 404. Use [native GitHub listeners](https://ampcode.com/docs/github)
([announcement](https://ampcode.com/news/github-listeners)) for GitHub events; this plugin provides
no wrappers or automatic migration. Recreate any needed listeners through Amp. Branch-wide GitHub
watches are deliberately not retained, and creating a PR no longer installs a watch automatically.

Existing GitHub tables and rows are left inert in deployed SQLite databases; startup does not
migrate or drop them. Fresh databases create only Buildkite/feed tables. Buildkite subscriptions,
branch/commit filters, delivery history, feed baselines, and webhook bindings remain intact. Keep
both the `subscribe.ts` filename and historical `github-pr-events:<AMP_THREAD_ID>` registration key:
the name is not a GitHub integration and changing it would break durable webhook identity.

Deploy the bridge through the normal release workflow and reload the updated plugin. Buildkite/feed
subscriptions do not need recreating. The old URL/audience environment aliases
`AMP_GITHUB_RELAY_URL` / `AMP_GITHUB_RELAY_AUDIENCE` and `urn:lox:amp-github-relay` audience remain
accepted for existing Buildkite/feed clients; prefer `AMP_SUBSCRIBE_URL` / `AMP_SUBSCRIBE_AUDIENCE`.

Retiring the Buildkite-owned `buildkite-amp-subscribe` GitHub App, its webhook, and unused GitHub
secrets is a separate operational change requiring approval. The shared service remains
`bk-amp-subscribe`; the personal `lox-amp-subscribe` stack is unrelated. Importing the updated
dashboard is also separate from changing its versioned definition.

### Upgrade from a shared webhook

Deploy the updated bridge **before** updating the plugin. On startup, the plugin registers
`github-pr-events:<AMP_THREAD_ID>` and calls `PUT /api/webhook` with
`{ "webhookUrl": "...", "webhookBinding": "thread_v1" }`.
The bridge authenticates the orb and atomically moves only that thread's Buildkite and feed
subscriptions to the new URL. Subscription IDs, behaviors, delivery modes, event filters, delivery
history, and feed baselines are preserved. Existing feed tables gain a `webhook_binding`
column defaulting to `legacy`; Buildkite rows include the binding from creation. Repeated plugin loads
use the same key and safely repeat the update. An older bridge lacks this endpoint, so initialization fails
until the bridge is upgraded and the plugin is reloaded.

Reload the updated plugin in each subscribed thread to migrate it; dormant threads remain on the
old endpoint until their plugin starts. The old shared webhook is not deleted because other threads
may still use it. Do not roll back the plugin in migrated threads: that would restore shared URLs.
Subscriptions already deleted by the old relay must be recreated. Events missed before or during
the transition, including events queued at the old Amp registration, may need manual reconciliation
after migration. This change adds no retry queue or indefinite event retention; existing
HTTP 404/410 removal behavior remains, except that a late response from a replaced URL cannot remove
the migrated subscription. Archiving a subscribing thread can still stop its own notifications.

#### Tracking completion and retiring legacy clients

The plugin declares `webhookBinding: "thread_v1"` on migration and new subscriptions. The bridge
persists it and returns it in subscription lists. Omitted bindings mean `legacy`, including on
updates: an old plugin writing a shared URL clears the migrated marker. This is a client-declared
version, not independent proof of Amp webhook ownership, handler execution, or successful wakeup.

Watch `amp_subscribe_webhook_bindings{binding="legacy"}` for `source="buildkite"` and
`source="feed"`; [dashboard queries](dashboards/README.md#webhook-migration) are provided. It counts
current subscriptions, not distinct threads or cumulative migrations. All four binding/source series
are emitted even at zero. Missing metrics or an unavailable scrape must not be interpreted as zero.

To identify remaining threads without exposing capability URLs, run this query against a read-only
connection to the bridge's SQLite database:

```sql
SELECT 'feed' AS source, id, thread_id, webhook_binding
FROM feed_subscriptions WHERE webhook_binding = 'legacy'
UNION ALL
SELECT 'buildkite', id, thread_id, webhook_binding
FROM buildkite_subscriptions WHERE webhook_binding = 'legacy'
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

### Response modes

- `notify`: report what happened without changing anything.
- `investigate` (default): inspect and explain the event without changing external state.
- `implement`: make and verify local changes, but do not push without permission.

You can also ask Amp to list or remove this thread's Buildkite or feed subscriptions.

## How it works

```text
Buildkite ───webhook──────┬──▶ amp-subscribe ──durable webhook──▶ Amp thread
RSS/Atom ───poll──────────┘          ▲                                │
                                    └──────── subscription ──────────┘
```

The plugin creates **one durable webhook per thread**, shared only by that thread's
Buildkite and feed subscriptions. Amp shares registrations for the same user/project/plugin/key,
so the key includes the orb's `AMP_THREAD_ID` instead of using one fixed project-wide key.
Registration happens when the plugin loads, including on orb restart, without waiting for a tool
call or session-start event.
Missing thread identity is an error; the plugin does not fall back to a shared key or UI focus.

The bridge stores the authenticated subscribing thread ID, verifies matching Buildkite events, and
forwards bounded metadata with that trusted target ID. The handler checks that its registration
owner, orb thread, and payload target all agree, then appends to the owning thread. It never forwards
to another thread. This isolates active subscribers from an unrelated thread's archived webhook
owner. Amp can store events and wake the owning thread while its orb is asleep. Feed events use the
same routing contract.

For feeds, the bridge polls public HTTPS URLs every five minutes by default. Set
`FEED_POLL_INTERVAL_SECONDS` to change the interval (minimum 30 seconds). Conditional requests are
used when feeds provide ETag or Last-Modified headers.

Buildkite subscriptions accept a delivery mode: `queue` never steers, `steer` always steers,
and `automatic` (the default) also steers all delivered events. Payloads without a delivery mode
steer too. Feed events always steer. This does not clear messages already queued in a thread.
Plugin logs include delivery reasons, steering decisions, and received/delivered/suppressed counts.

Buildkite delivery IDs are deduplicated durably by the bridge. The plugin's exact-event cache is
process-local. Before appending a Buildkite message, the plugin also reads the
target thread's recent transcript and suppresses an exact content match among user messages after
the latest assistant message. This catches a retry or restarted handler when the same generated
message is already stacked for the agent, while allowing changed build details and an
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
- `BUILDKITE_WEBHOOK_SECRET` to the Buildkite webhook token configured in signature mode.
- `BUILDKITE_ALLOWED_ORGANIZATIONS` to the comma-separated Buildkite organization slugs this bridge
  may accept and expose to subscribers.

Configure one organization-level Buildkite webhook notification service for the pipelines and build
events you want the bridge to route. Point it to `/buildkite/webhook`, use signature mode, and use the
same token as `BUILDKITE_WEBHOOK_SECRET`. See [Buildkite webhook setup](docs/buildkite.md).

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
  Buildkite/feed row counts. Repeated startup updates report zero changed rows.
- `legacy_webhook_rejected`: a retired client attempted a legacy binding write.
- `buildkite_webhook_processed`: content-derived delivery ID, event, organization/pipeline, matched
  subscriptions, deduplicated, delivered, failed and removed counts.
- `webhook_delivery_failed`, `subscription_removed`: subscription/thread IDs, binding version,
  exact HTTP status (or `null` for a transport failure), reason, idempotency key, endpoint host/hash
  and bounded `x-request-id`/`fly-request-id` response headers. These correlate a failed Buildkite
  delivery or feed entry with Amp diagnostics without logging capability URLs or response bodies.

An HTTP 2xx counted as `delivered` means Amp accepted the request, not that a message was appended
or the thread woke. For that boundary, use Amp's handler traces: the plugin logs webhook receipt
with the Amp event ID and owner/orb thread IDs, then its existing delivery/suppression decisions.
These plugin logs may be trace span events rather than durable local log files; their absence from
a file is not evidence the handler did not run. Preserve bridge logs externally if you need history
beyond the hosting provider's retention window; deletion still cascades the SQLite delivery ledger.

The included `fly.toml` targets Buildkite's `bk-amp-subscribe` Fly.io app. Successful CI runs on
pushes to `main` trigger deployment through `.github/workflows/deploy.yml`. Configure the GitHub
`production` environment to allow only the exact `main` branch (not tags), with no required
reviewers. Store `FLY_API_TOKEN` in that environment, not as a repository secret. It must contain
a deploy token for this app, not the previous `lox-amp-subscribe` app:

```sh
mise exec -- flyctl tokens create deploy --app bk-amp-subscribe --expiry 8760h | \
  gh secret set FLY_API_TOKEN --env production --repo buildkite/amp-subscribe
```

Before the first deployment, create the app in Buildkite's Fly organization if needed and set its
Buildkite webhook secret, Buildkite organization allowlist, and Amp allowlist secrets.
Point the Buildkite webhook to `https://bk-amp-subscribe.fly.dev/buildkite/webhook` and clients'
`AMP_SUBSCRIBE_URL` to `https://bk-amp-subscribe.fly.dev` when cutting over. The existing OIDC
audiences are retained for client compatibility. The old app's SQLite subscriptions do not move
automatically; migrate the database or recreate subscriptions on the new app.

For a separate self-hosted deployment, change the app name, region, and OIDC audience, then create
the app and set its secrets:

```sh
APP=your-amp-subscribe-app
mise exec -- flyctl apps create "$APP"
mise exec -- flyctl secrets set --app "$APP" \
  BUILDKITE_WEBHOOK_SECRET=... \
  BUILDKITE_ALLOWED_ORGANIZATIONS=... \
  AMP_ALLOWED_WORKSPACE_IDS=...
mise exec -- flyctl deploy --remote-only --app "$APP"
```

## Security

The subscription API authenticates Amp with short-lived workload identity tokens and derives the
thread owner from the signed identity. Forwarded target thread IDs come only from those authenticated
subscription records, not Buildkite or feed content. Buildkite webhooks are
signature-checked, deliveries are deduplicated per subscription, and outbound delivery is restricted
to configured HTTPS hosts. Buildkite signatures older than five minutes are rejected.

Buildkite forwarding is limited to pipeline/build IDs, state, branch, commit, canonical
URLs, and timestamps. It excludes build messages, environment variables, job logs, and annotations;
Amp retrieves current details using its separately authenticated Buildkite tools.

Feed downloads are limited to public HTTPS endpoints and 1 MiB. Forwarded feed events contain
bounded entry metadata but not descriptions or body content; the plugin treats feed titles and
linked pages as untrusted data.

## Development

```sh
mise run ci
```

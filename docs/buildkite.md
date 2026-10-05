# Buildkite webhook setup

Create one organization-level outgoing webhook notification service for each Buildkite organization
that amp-subscribe should receive events from. The bridge filters those organization-wide events
against each thread's pipeline subscriptions.

## Configuration

In **Organization settings → Notification Services → Webhook** configure:

- **Webhook URL:** `https://your-bridge.example/buildkite/webhook`
- **Token:** a new random secret, also stored as `BUILDKITE_WEBHOOK_SECRET` on the bridge
- **Token mode:** Signature
- **Events:** the supported event superset you intend to offer: `build.scheduled`, `build.running`,
  `build.failing`, `build.finished`, and `build.skipped`
- **Pipelines:** all pipelines, or the subset this bridge should expose
- **Verify TLS certificates:** enabled

Set `BUILDKITE_ALLOWED_ORGANIZATIONS` on the bridge to the comma-separated organization slugs it may
accept. This prevents a valid webhook configuration from routing a different organization's events
or allowing subscriptions outside the intended organizations.

You can instead create the service through Buildkite's Notification Services API with an
organization administrator token carrying `write_notification_services`:

```sh
curl -H "Authorization: Bearer $BUILDKITE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "https://api.buildkite.com/v2/organizations/$ORGANIZATION/services" \
  -d "$(jq -n \
    --arg url 'https://your-bridge.example/buildkite/webhook' \
    --arg token "$BUILDKITE_WEBHOOK_SECRET" \
    '{
      provider: "webhook",
      description: "amp-subscribe",
      scope: "all",
      settings: {
        url: $url,
        token: $token,
        token_mode: "signature",
        events: ["build.scheduled", "build.running", "build.failing", "build.finished", "build.skipped"],
        tls_verify: true
      }
    }')"
```

The API token is needed only to provision the notification service. Do not store it in the bridge.
Buildkite signs `timestamp.raw-body` with HMAC-SHA256; the bridge verifies the signature and rejects
dispatch timestamps outside a five-minute window.

## Subscription filters

`buildkite_pipeline_subscribe` accepts optional `branch` and `commit` filters:

```json
{
  "pipeline": "buildkite/my-pipeline",
  "branch": "feature/my-change",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "events": ["build.failing", "build.finished"],
  "behavior": "investigate",
  "deliveryMode": "steer"
}
```

Use the actual full pushed SHA for `commit`, not the example value. Branch names match exactly and
are case-sensitive, without glob matching. Commits require a full 40- or 64-character hexadecimal
SHA and match without regard to hex letter case. When both filters are supplied, both must match.
A build without a valid full commit SHA cannot match a commit-filtered subscription.

Without filters, all branches and commits in the pipeline are eligible. There is one subscription
per thread and pipeline: re-subscribing replaces its filters, and omitted filters are cleared.
After pushing again, re-subscribe with the new head SHA. Listing subscriptions returns the stored
filters. A build URL passed as `pipeline` selects only its pipeline, not the individual build.

The subscription API accepts the same optional `branch` and `commit` fields at
`POST /api/buildkite-subscriptions`. Existing subscriptions remain unfiltered on upgrade, and the
database migration preserves their IDs and delivery history. Deploy the updated bridge before
updating the plugin; older bridges do not apply these filters. The updated plugin checks the saved
filters and removes the subscription with an error if the bridge did not retain them.

## Investigation access

The webhook intentionally excludes job data and logs. For `investigate` and `implement` behavior,
give the Amp environment read-only Buildkite access through the Buildkite MCP server or `bk` CLI.
Typical CLI investigation uses:

```sh
bk build view 42 -p organization/pipeline -s failed,broken
bk job log JOB_UUID --agent --max-tokens 4000
```

Use at least `read_builds` and `read_build_logs` token scopes. Write scopes are not required for
subscription delivery or investigation.

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

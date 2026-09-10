# Dashboards

`amp-subscribe-custom-metrics.json` is a Grafana dashboard for the [custom metrics](../src/metrics.ts)
this bridge exposes (subscription counts, webhook delivery outcomes, feed poll results, and
subscription API traffic — see the README's [Self-hosting](../README.md#self-hosting) section).

It's built for Fly.io's managed Grafana at [fly-metrics.net](https://fly-metrics.net), which is
preconfigured with a `Prometheus on Fly` datasource (`uid: prometheus_on_fly`) scoped to your Fly.io
organization. Anyone with access to the org that runs this bridge can already see it there under
**Dashboards**, no separate sharing step required — Grafana access follows Fly.io org membership.

This JSON file exists so the dashboard survives independently of Grafana's own state: it's versioned,
reviewable in PRs, and re-importable if the dashboard is ever deleted, needs recreating for another
Fly.io organization, or you want to fork it for a variant.

Fly.io doesn't (yet) offer a way to declare dashboards as code alongside `fly.toml`, so this is the
closest conventional equivalent: an exported dashboard JSON model kept in the repo, imported by hand
when needed.

## Importing

1. Go to [fly-metrics.net](https://fly-metrics.net) and switch to the correct organization (bottom of
   the left sidebar / account menu).
2. **Dashboards → New → Import**.
3. Paste the contents of `amp-subscribe-custom-metrics.json` into the "Import via dashboard JSON model"
   box (or upload the file), then **Load** and **Import**.

If a dashboard with the same UID (`dfx41yxf19xq8f`) already exists in that org, importing again updates
it in place rather than creating a duplicate.

## Webhook migration

After deploying the per-thread webhook bridge, add a Stat panel for **Legacy subscriptions remaining**:

```promql
sum by (app) (amp_subscribe_webhook_bindings{app=~"$app",binding="legacy"})
```

For a time series showing both versions and GitHub/feed sources:

```promql
sum by (app, source, binding) (amp_subscribe_webhook_bindings{app=~"$app"})
```

Use the existing `$app` variable and `Prometheus on Fly` datasource. These queries are ready to add;
the exported dashboard JSON and live Grafana dashboard are not changed by this documentation.
Keep “No data” distinct from zero and verify fresh, healthy scrapes. The gauge is rebuilt from the
database on every scrape, with explicit zeroes for every source/version pair and no per-thread or
URL labels.

Zero means no **retained legacy subscription rows**, not that all old threads migrated or Amp's
old webhook queues drained. Deletions also lower it. Follow the README's
[retirement procedure](../README.md#upgrading-an-existing-bridge), including reconciling removal
logs and dormant threads and closing old-client writes before the final zero check. The
thread-only bridge retains these series for rollout/rollback diagnostics but does not accept or
migrate legacy subscriptions.

## Keeping this file in sync

There's no automated push from Grafana back to this repo. After editing the dashboard in the Grafana UI,
re-export it (dashboard settings → JSON Model, or **Share → Export → Save to file**) and commit the
updated JSON here, so the file stays a true backup of what's live.

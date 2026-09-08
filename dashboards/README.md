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

## Keeping this file in sync

There's no automated push from Grafana back to this repo. After editing the dashboard in the Grafana UI,
re-export it (dashboard settings → JSON Model, or **Share → Export → Save to file**) and commit the
updated JSON here, so the file stays a true backup of what's live.

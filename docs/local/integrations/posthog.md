# PostHog

PostHog can help an agent inspect an existing product's analytics. It does not add analytics or tracking to the Plompy website and is not needed for company discovery.

## Set up

For project discovery, enable the fixed read tool explicitly:

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs add posthog --mode local \
  --auth api-key --tools projects-get
```

Other permitted names are `event-definitions-list`, `insights-get-all`, `insight-get`, `dashboards-get-all` and `dashboard-get`, when the upstream actually advertises them. Select only the tools needed for your task. Provide a scoped personal API key through the credential workflow. Do not expose an entire account's catalog automatically.

The gateway reuses the fixed PostHog destination and read-only request header from the managed bridge. Its local tool allowlist remains a separate restriction.

## Try it

```text
Use the enabled PostHog read tools to inspect the project I authorized.
Summarize the requested metric and its time range. Make no changes.
```

## Authentication and costs

You need access to the intended PostHog project. Existing query costs and account limits may apply. The local gateway does not import a runner's OAuth login.

## Test deliberately

A configured credential is not proof of the intended project access. Run an explicit read-only live test against that project. Never create an event, dashboard, annotation or other remote object merely to verify connectivity.

Do not put personal analytics data into company-research exports. Read [data flow](../security.md) before allowing a model to process private project results.

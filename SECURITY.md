# Security

This early single-owner engine runs code and an optional authenticated browser on your machine.
Treat the service account, configured model, plugins and host filesystem as trusted components.
Environment filtering does not isolate processes sharing a Unix UID. Browser URL guards are
best-effort navigation checks, not a network firewall. Prompt instructions are not an enforcement
boundary for hostile pages or generated code.

Use a dedicated account, explicit task authority, private state directories and least-privilege
credentials. Keep the public engine source separate from your private workspace and backups.
Do not grant a model unrestricted administrator credentials.

For a suspected vulnerability, use GitHub's private vulnerability reporting **if the repository
shows that option**. Otherwise use the maintainer contact on the linked GitHub profile before
sending sensitive details. Do not post secrets, cookies, raw logs or exploit details publicly.
No response-time SLA or independently audited security claim is offered.

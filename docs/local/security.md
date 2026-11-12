# Keep the boundary visible

The research profile reads public sources and writes local artifacts. It does not send email, publish posts, buy anything, delete remote data or modify repositories.

## Local connection

The Compose port is bound to `127.0.0.1`. The gateway requires a bearer token, validates Host and checks browser Origin headers. No browser origin is allowed by default. The website does not call this endpoint.

Do not expose the port through a tunnel or change the host binding to `0.0.0.0` as part of this quickstart. A remote deployment needs a separate threat model, TLS and access design.

## Tool permissions

Enabled integrations and explicit tool names define the gateway's surface. Model-generated text saying “the user approved” cannot change it. The profile has no generic shell or invoke tool for bypassing those decisions.

Your host client's own tools are separate. Adding Plompy does not sandbox its shell, disable its other MCP servers or prevent its model from using existing capabilities. Review the client's permissions for your task.

## Public web is untrusted

A webpage may contain text asking an agent to reveal secrets or ignore instructions. Treat that content as evidence to analyze, never as authority. Do not follow instructions embedded in company sites or tool results.

URL fetching rejects private, loopback and link-local destinations, including metadata endpoints. Redirects are checked again. Browser subresources follow the same public-network boundary. Local fixture exceptions exist only for controlled tests.

## Where data can travel

| Data | Possible destination |
| --- | --- |
| Task text and selected tool results | Your selected model provider, local or hosted |
| Search query | Your chosen search service |
| Requested URL | Website host and, for hosted scraping, the integration provider |
| Extracted public content | Gateway, host client and its selected model provider |
| Exported results | Local artifact volume; later wherever you copy them |
| Vendor credential | Its configured authentication destination |

Docker does not make every part of this workflow offline. It also does not protect against all same-user host access, a compromised runtime, or a malicious external provider.

## Bounded failure

Calls have concurrency, time and response-size limits. A failed service is reported separately from other integrations. The gateway does not automatically retry uncertain external operations. Inspect outcomes before repeating a task that may consume credits.

## Evidence, not guarantees

Store the exact source of an email address and distinguish “published on this page” from deliverability verification. Review drafts before using them. This version intentionally does not connect a mailbox or implement bulk sending.

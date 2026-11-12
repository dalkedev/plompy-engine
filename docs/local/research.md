# Find a project partner. Keep the evidence.

This example uses the general tools to research companies and draft messages. It does not turn Plompy into a mailing platform and needs no mailbox credentials.

## Describe the project first

Give your agent facts it can use: the degree or course, the kind of application you can build, the project deadline, your skills, preferred location, and whether the work is a prototype or production deliverable. Do not let it invent your experience, a partnership or promises you cannot keep.

## Start with a small batch

Connect a [search provider](integrations.md), basic page reading and artifact storage. Use [Playwright](browser.md) only when needed. Verify a few results before increasing the batch.

```text
I am preparing a university project. Find up to 3 companies in Poland
that develop mobile applications and could be relevant project partners.

Use search to discover candidates, then read their official websites.
For each company, record its name, website, industry, location, match
reason and source URLs. Find a public business email only if it appears
explicitly on an official page. Record the exact URL where it appears.
Do not guess email patterns or claim deliverability verification.

Draft a short Polish message proposing a conversation about a university
project. Use only verified company facts. Leave placeholders for my name,
course, deadline and concrete project proposal until I provide them.

Deduplicate companies and email addresses. Save CSV, JSON and a Markdown
summary with the artifact tools. If fewer than 3 valid matches are found,
return the real number and explain the gaps. Do not send any messages,
submit forms, create accounts or connect to a mailbox.
```

For the larger run, replace 3 with 30. The requested count is a ceiling, not permission to fill gaps with made-up data.

## Export fields

| Field | Meaning |
| --- | --- |
| `company_name` | Name shown by the source |
| `website` | Official website |
| `industry` | Source-supported description |
| `location` | Published location or empty |
| `public_email` | Explicitly published business contact or empty |
| `source_url` | Exact page that supports the contact |
| `checked_at` | Time the page was checked |
| `match_reason` | Factual explanation of relevance |
| `evidence_status` | For example `published_on_official_site`, not `deliverability_verified` |
| `draft_subject` | Proposed subject line |
| `draft_body` | Draft only |

Use additional evidence URLs if a match reason and email are supported by different pages. A directory's claim about a company is not equivalent to confirmation on the company's website.

## Review the result

Open the cited pages. Check the proposed match, email source, spelling and the claims about you. Remove unrelated contacts. Edit each draft in your own voice before deciding how to contact a company.

No test or example in this repository sends mail. Actual sending is outside this first profile.

## Agent instructions

The source checkout includes `examples/local/AGENTS.md` and `examples/local/company-research.md`. Merge the instructions deliberately into the project used by your host client: use its supported instruction file, such as `AGENTS.md` for Codex/OpenCode or `CLAUDE.md` for Claude Code. Preserve existing project guidance and fill in your own project context. They explain source handling and draft-only behavior; they do not configure MCP.

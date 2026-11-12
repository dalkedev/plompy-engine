# University project: company research

Fill these facts in before asking the agent to personalize messages:

- Course / university:
- Project idea and scope:
- Skills and technologies:
- Deadline:
- Preferred company type and location:
- Your name and how a company should reply:

## Prompt

Find up to 30 Polish companies developing mobile applications. Discover candidates
with the configured search integration, then inspect their official websites.
Record company_name, website, industry, location, public_email, source_url,
checked_at, match_reason, evidence_status, draft_subject and draft_body.

Use only explicitly published business contacts. Keep the exact page where each
email address appears. Do not guess addresses or claim deliverability verification.
Deduplicate companies and email addresses. Draft concise Polish messages proposing
a conversation about my university project, using only the supplied personal facts
and facts supported by the company sources. Leave missing personal facts as
placeholders. Save CSV, JSON and a readable Markdown summary with artifact tools.

Return fewer than 30 if evidence is missing and explain the gaps. Do not send email,
submit forms, create accounts or connect to a mailbox.

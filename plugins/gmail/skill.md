---
name: career-ops-plugin-gmail
description: How to pull job leads from a Gmail label into the career-ops pipeline.
license: MIT
---

# gmail plugin

Reads the `Job Leads` label for the verified target account
`jakyejobs@gmail.com`, extracts clean job URLs from authentic (DMARC-passing)
emails, and returns them as leads. The engine writes them to the pipeline.

## Command

- `node plugins.mjs run gmail` — ingest new leads from the configured label.

## Setup

Put `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN` in `.env`
(an OAuth Desktop client + a refresh token authorized for `jakyejobs@gmail.com`).
The organizer requires the Gmail modify scope
`https://www.googleapis.com/auth/gmail.modify` plus the filter-management scope
`https://www.googleapis.com/auth/gmail.settings.basic`; the ingest hook itself
remains read-only. Configure the account, label, and lookback in
`config/plugins.yml`:

```yaml
plugins:
  gmail:
    enabled: true
    account_email: "jakyejobs@gmail.com"
    label: "Job Leads"
    days_back: 7
    max_messages: 200
```

## Data it produces

`Job[]` ({ title, url, company, location }) — the engine de-dups against the
pipeline and appends new ones. It maintains its own processed-message cursor in
`data/gmail-state.json` to avoid re-reading the same emails.

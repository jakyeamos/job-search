# Mode: tracker — Applications Tracker

Read `data/search-ops.md` first when it exists, then read and display
`data/applications.md`. The search-ops board is the active execution layer;
`data/applications.md` remains the application history and evaluation ledger.

If the user asks what to do next, how the search is going, or for a weekly
review, route to `modes/weekly.md` after loading the same two files.

**Tracker Format:**

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

Possible states: `Evaluated` → `Applied` → `Responded` → `Interview` → `Offer` / `Rejected` / `Discarded` / `SKIP`

- `Evaluated` = offer evaluated with report, pending decision
- `Applied` = the candidate submitted their application
- `Responded` = Company has responded (not yet interview)
- `Interview` = active interview process
- `Offer` = job offer received
- `Rejected` = rejected by company
- `Discarded` = discarded by candidate or offer closed
- `SKIP` = doesn't fit, don't apply

If the user asks to update a state, edit the corresponding row.

Also show statistics:
- Total applications
- Breakdown by state
- Submitted applications separately from `Evaluated` and `SKIP`
- Current-week applications when the active week is present in `data/search-ops.md`
- Average score
- % with PDF generated
- % with report generated

Never treat an evaluated-but-unsubmitted role as an application. Keep the
historical tracker unchanged unless the user explicitly supplies a status
update for a specific row.

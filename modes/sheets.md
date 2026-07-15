# Mode: sheets — Career Ops Google Sheets refresh

Use this mode when the candidate asks to refresh or sync the application
tracker spreadsheet.

## Read order

1. `config/google-sheets.json` for the spreadsheet URL and exact tab names
2. `data/applications.md` for the evaluation history
3. `data/search-ops.md` for the active weekly board

Run `pnpm sheets:export` before a refresh. The generated packet under
`output/sheets/` is a deterministic snapshot of the Career Ops queue and
weekly board.

## Sync rules

- Use the available Google Drive/Sheets connector when one is available.
- Read spreadsheet metadata and exact target ranges before editing.
- Refresh `Career Ops Queue` and `Weekly Ops` from the export packet.
- Preserve manually maintained `Applications` and `Outreach` rows.
- Never convert `Evaluated` or `SKIP` into `Applied`.
- Keep `Application Stage` manual unless the candidate supplies a confirmed
  submission or interview stage.
- Re-read the edited tabs and report the row counts and any connector errors.

If the connector is unavailable, leave the packet in `output/sheets/` and give
the candidate the configured spreadsheet URL plus the exact tabs that need the
refresh.

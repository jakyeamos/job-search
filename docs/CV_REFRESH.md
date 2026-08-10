# CV evidence refresh

`pnpm cv:refresh` inventories Git repositories under the explicit local roots
`~/projects` and `~/Documents`, then reports project evidence that may need review
against `cv.md`, `article-digest.md`, and the accomplishment ledger.

The scanner is intentionally report-only. It reads repository metadata, recent Git
state, README/project-truth files, package metadata, and the existing CV sources.
It does not approve projects, invent metrics, infer customers or outcomes, treat
dirty-branch work as released, or edit the canonical CV files.

The generated snapshot is written under `output/cv-refresh/`, which is local
generated state. Review the report, update the user-layer source files manually,
then run `pnpm sync-check` and regenerate the full CV PDF.

Useful commands:

```bash
pnpm cv:refresh
pnpm cv:refresh:json
pnpm cv:refresh:check
pnpm cv:refresh --root ~/projects --root ~/Documents
```

`--check` exits with status `2` when review candidates or stale ledger references
exist, which lets a weekly automation surface work without applying it.

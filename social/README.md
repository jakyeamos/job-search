# Social Content Registry

`config/social.json` is the canonical source for Jakye's public build-in-public
identity, project lanes, disclosure boundaries, and launch backlog.

The registry is intentionally separate from the application tracker. A job
application is a private pipeline record; a social item is public proof that
must remain traceable to verified evidence and an approved artifact.

Career-Ops consumes this registry through its native review commands. The registry
is not an instruction to publish automatically. Every social item remains pending
until Jakye reviews the wording, asset, audience, and privacy boundary.

Use the project `tier` and lane `contentBudget` to prevent a large project
inventory from becoming a large number of unrelated public identities. The
personal account is the distribution surface; FRMWRK Labs and the portfolio
are owned archives with their own editorial voices.

The current narrative lanes are Tenure, Engineering Systems, Data and Product
Systems, and Client Delivery. The supporting registry also covers Soundscape,
GitHub Issue Resolution Modeling, FRMWRK Labs, and Chiron's Forge so their
public surfaces can be selected when a role or story makes them relevant.

## Writing pipeline

Each backlog item now carries a human brief: the concrete context, Jakye's
personal angle, the current next step, and a topical voice profile. Career-Ops
turns that brief into destination variants through this ordered pipeline:

```text
verified brief -> domain draft -> claim/boundary QA -> general humanizer
-> destination voice (LinkedIn, X, Instagram, native video, portfolio, or FRMWRK Labs) -> human approval
```

The general pass removes inventory labels, metadata-shaped prose, filler, and
promotional language. The destination pass changes the shape and level of
reflection for the surface: LinkedIn is recruiter-readable, X is compact and
conversational, Instagram is visual and save-oriented, native video shows the
working surface early, the portfolio is explanatory, and FRMWRK Labs is a more
reflective lab note. Neither pass may add facts, outcomes, users, customers,
revenue, or adoption claims. The source references and disclosure boundaries
remain attached to the review object rather than being dumped into the post.

The Career-Ops workflow is intentionally explicit:

```text
pnpm social verify
pnpm social plan
pnpm social next --limit 5
pnpm social variant --item tenure-problem --platform linkedin
pnpm social variant --item tenure-demo --platform instagram
pnpm social outcome --item tenure-problem --platform linkedin --publication-outcome published
pnpm proof:scan --date 2026-07-22
```

Generated plans and outcome logs stay in Career-Ops' ignored `output/social/`
runtime directory. The proof scan writes a redacted review artifact under
`output/proof-scan/`. LinkedIn, X, and Instagram remain manual publishing
surfaces.
Longer Markdown articles can be reviewed for both the portfolio writer and
FRMWRK Labs, but a social atom never exposes private repositories, credentials,
client data, or unsupported adoption claims.

## Platform-wide research

Read `social/platform-research.md` before changing cadence or format. It records
current platform-level evidence and the operating rules derived from it. The
default system does not generate every atom for every platform: Instagram is
selected explicitly for visual-ready items, while LinkedIn, X, and owned
surfaces receive distinct destination variants.

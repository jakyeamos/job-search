# Browser runtime for external pages

Career Ops launches installed **stable Google Chrome** for job postings, company
pages, application forms, and other external URLs. Install Chrome through its
normal distribution and keep it updated. Run `pnpm doctor` to check that the
installed browser launches with the project's Playwright version.

Every owned external-page launch goes through `external-browser.mjs`, which sets
`channel: 'chrome'` and `chromiumSandbox: true` in both headed and headless modes.
Application commands also accept `--browser msedge` (or
`CAREER_OPS_BROWSER_CHANNEL=msedge`) for installed stable Microsoft Edge. Only
`chrome` and `msedge` are supported; pinned Chromium and prerelease channels are
rejected before launch. The doctor checks the default Chrome runtime.

If launch fails, the command reports the failure without retrying another
browser or disabling the sandbox. Check the browser installation, updates, and
compatibility with the pinned Playwright package. Installing Playwright's bundled
Chromium does not satisfy this external-browsing requirement.

## Attaching to an existing browser

Application commands with an explicit `--cdp-endpoint` attach to that browser
instead of launching one. This preserves the existing authenticated session.
Attachment does not change or verify the process's sandbox settings, version,
or update status. Check those in the browser before using that route; do not
treat a successful connection as evidence that the launch policy was applied.
The application-packet command also accepts an existing endpoint from
`CAREER_OPS_CDP_ENDPOINT` or `OPENCLI_CDP_ENDPOINT`; the same limitation applies.

## Maintenance and scope

Route new external-page launch sites through `launchExternalBrowser`; do not add
custom executable paths, sandbox-disabling flags, or browser fallbacks. Existing
URL guards and application approval boundaries still apply. The sandbox option
and successful launch are not an independent attestation of operating-system
sandbox enforcement.

Local PDF rendering and controlled browser tests retain their existing browser
setup. Their pinned browser installation is separate from external browsing.
See [setup](SETUP.md) for PDF prerequisites and
[application commands](../apply/README.md) for browser selection and attachment.

The launch contract is covered by `tests/external-browser.test.mjs`. Its small
browser doubles check the Playwright API options, rejected channels, single
attempt on launch failure, and preserved explicit attachment. A live launch is
still needed to check compatibility with the installed browser.

Playwright documents the [Chromium sandbox option](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox)
and [installed browser channels](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge).

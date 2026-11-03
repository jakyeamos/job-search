/**
 * Launch policy for untrusted external pages. Playwright's library defaults
 * disable Chromium sandboxing and select a pinned test browser.
 * Keep local PDF rendering and controlled tests outside this policy.
 */

/** @param {typeof import('playwright').chromium} chromium
 * @param {{ headless?: boolean, channel?: string }} [options]
 */
export async function launchExternalBrowser(chromium, { headless = true, channel = 'chrome' } = {}) {
  if (channel !== 'chrome' && channel !== 'msedge') {
    throw new Error('External browsing requires stable Chrome (chrome) or Edge (msedge); pinned and prerelease channels are not supported.');
  }
  try {
    return await chromium.launch({ channel, headless, chromiumSandbox: true });
  } catch (cause) {
    throw new Error(
      `Could not launch sandboxed ${channel}. Install or update the stable browser and check Playwright compatibility. The sandbox must remain enabled; no alternate browser was tried.`,
      { cause },
    );
  }
}

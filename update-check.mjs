const RAW_VERSION_URL = 'https://raw.githubusercontent.com/santifer/career-ops/main/VERSION';
const RELEASES_API = 'https://api.github.com/repos/santifer/career-ops/releases/latest';

function compareVersions(a, b) {
  const local = String(a).split('.').map(Number);
  const remote = String(b).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((local[index] || 0) < (remote[index] || 0)) return -1;
    if ((local[index] || 0) > (remote[index] || 0)) return 1;
  }
  return 0;
}

export async function checkForUpdate({ local, dismissed }) {
  if (dismissed) return { status: 'dismissed' };
  let remote;
  try {
    const response = await fetch(RAW_VERSION_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    remote = (await response.text()).trim().split(/\s+/)[0];
  } catch {
    return { status: 'offline', local };
  }
  if (local !== 'unknown' && compareVersions(local, remote) >= 0) {
    return { status: 'up-to-date', local, remote };
  }
  let changelog = '';
  try {
    const response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github.v3+json' } });
    if (response.ok) changelog = (await response.json()).body || '';
  } catch {
    // Release notes are optional; update protection is enforced during preview/apply.
  }
  return { status: 'update-available', local, remote, changelog: changelog.slice(0, 500) };
}

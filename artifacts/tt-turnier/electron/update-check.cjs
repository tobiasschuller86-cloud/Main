const RELEASE_NOTES_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/latest\/?$/;
const WINDOWS_INSTALLER = /^Tischtennis-Turnier-(\d+\.\d+\.\d+)-x64-(?:signed|unsigned)\.exe$/;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    normalized: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
  };
}

function isNewerVersion(latest, current) {
  const latestVersion = parseVersion(latest);
  const currentVersion = parseVersion(current);
  if (!latestVersion || !currentVersion) return false;

  for (const field of ['major', 'minor', 'patch']) {
    if (latestVersion[field] !== currentVersion[field]) {
      return latestVersion[field] > currentVersion[field];
    }
  }

  return currentVersion.prerelease !== null && latestVersion.prerelease === null;
}

async function checkForNewerWindowsRelease({
  releaseNotesUrl,
  currentVersion,
  fetchImpl = globalThis.fetch,
}) {
  const urlMatch = typeof releaseNotesUrl === 'string' ? releaseNotesUrl.match(RELEASE_NOTES_URL) : null;
  if (!urlMatch || !parseVersion(currentVersion) || typeof fetchImpl !== 'function') {
    return { status: 'unavailable' };
  }

  const [, owner, repository] = urlMatch;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repository}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Tischtennis-Turnier',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { status: 'unavailable' };

    const release = await response.json();
    const latestVersion = parseVersion(release?.tag_name);
    const installer = Array.isArray(release?.assets)
      ? release.assets.find((asset) => {
        const match = typeof asset?.name === 'string' ? asset.name.match(WINDOWS_INSTALLER) : null;
        if (!match || parseVersion(match[1])?.normalized !== latestVersion?.normalized) return false;
        try {
          const downloadUrl = new URL(asset.browser_download_url);
          return downloadUrl.protocol === 'https:'
            && downloadUrl.hostname === 'github.com'
            && downloadUrl.pathname === `/${owner}/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
        } catch {
          return false;
        }
      })
      : null;
    if (!latestVersion || !installer) return { status: 'unavailable' };

    return {
      status: isNewerVersion(release.tag_name, currentVersion) ? 'available' : 'current',
      currentVersion,
      latestVersion: latestVersion.normalized,
      ...(isNewerVersion(release.tag_name, currentVersion)
        ? { downloadUrl: installer.browser_download_url }
        : {}),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

module.exports = { checkForNewerWindowsRelease, isNewerVersion, parseVersion };

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkForNewerWindowsRelease, isNewerVersion, parseVersion } = require('./update-check.cjs');

const releaseNotesUrl = 'https://github.com/example/tt-turnier/releases/latest';

function mockFetch(release, status = 200) {
  return async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/tt-turnier/releases/latest');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    return { ok: status >= 200 && status < 300, json: async () => release };
  };
}

test('parses stable and prerelease versions and compares them numerically', () => {
  assert.equal(parseVersion('v1.12.3').normalized, '1.12.3');
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.2.3', '1.2.3-beta.1'), true);
  assert.equal(isNewerVersion('1.2.3-beta.2', '1.2.3-beta.1'), false);
  assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
});

test('reports a newer release only when its Windows installer is published', async () => {
  const result = await checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: '1.2.3',
    fetchImpl: mockFetch({
      tag_name: 'v1.3.0',
      assets: [{
        name: 'Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
        browser_download_url: 'https://github.com/example/tt-turnier/releases/download/v1.3.0/Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
      }],
    }),
  });
  assert.deepEqual(result, {
    status: 'available',
    currentVersion: '1.2.3',
    latestVersion: '1.3.0',
    downloadUrl: 'https://github.com/example/tt-turnier/releases/download/v1.3.0/Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
  });
});

test('reports the installed version when there is no newer release', async () => {
  const result = await checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: '1.3.0',
    fetchImpl: mockFetch({
      tag_name: 'v1.3.0',
      assets: [{
        name: 'Tischtennis-Turnier-1.3.0-x64-signed.exe',
        browser_download_url: 'https://github.com/example/tt-turnier/releases/download/v1.3.0/Tischtennis-Turnier-1.3.0-x64-signed.exe',
      }],
    }),
  });
  assert.deepEqual(result, { status: 'current', currentVersion: '1.3.0', latestVersion: '1.3.0' });
});

test('does not report a newer release until a matching Windows installer exists', async () => {
  const result = await checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: '1.2.3',
    fetchImpl: mockFetch({
      tag_name: 'v1.3.0',
      assets: [{
        name: 'Tischtennis-Turnier-1.2.3-x64-unsigned.exe',
        browser_download_url: 'https://github.com/example/tt-turnier/releases/download/v1.3.0/Tischtennis-Turnier-1.2.3-x64-unsigned.exe',
      }],
    }),
  });
  assert.deepEqual(result, { status: 'unavailable' });
});

test('rejects installer assets whose direct link is outside the configured release', async () => {
  const result = await checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: '1.2.3',
    fetchImpl: mockFetch({
      tag_name: 'v1.3.0',
      assets: [{
        name: 'Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
        browser_download_url: 'https://example.com/download/Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
      }],
    }),
  });
  assert.deepEqual(result, { status: 'unavailable' });
});

test('rejects installer links that point to a different release tag', async () => {
  const result = await checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: '1.2.3',
    fetchImpl: mockFetch({
      tag_name: 'v1.3.0',
      assets: [{
        name: 'Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
        browser_download_url: 'https://github.com/example/tt-turnier/releases/download/v1.2.3/Tischtennis-Turnier-1.3.0-x64-unsigned.exe',
      }],
    }),
  });
  assert.deepEqual(result, { status: 'unavailable' });
});

test('returns unavailable for invalid release links and failed requests', async () => {
  assert.deepEqual(await checkForNewerWindowsRelease({
    releaseNotesUrl: 'https://example.com/releases/latest',
    currentVersion: '1.2.3',
    fetchImpl: mockFetch({}),
  }), { status: 'unavailable' });
  assert.deepEqual(await checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: '1.2.3',
    fetchImpl: mockFetch({}, 503),
  }), { status: 'unavailable' });
});

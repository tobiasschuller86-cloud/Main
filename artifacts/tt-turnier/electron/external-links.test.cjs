const assert = require('node:assert/strict');
const test = require('node:test');
const { createWindowOpenHandler, openExternalSafely } = require('./external-links.cjs');

test('opens official GitHub release notes externally and denies an app window', () => {
  const openedUrls = [];
  const handleWindowOpen = createWindowOpenHandler((url) => openedUrls.push(url));
  const releaseNotesUrl = 'https://github.com/example/tt-turnier/releases/latest';

  assert.deepEqual(handleWindowOpen({ url: releaseNotesUrl }), { action: 'deny' });
  assert.deepEqual(openedUrls, [releaseNotesUrl]);
});

test('blocks external destinations outside GitHub', () => {
  const openedUrls = [];
  const handleWindowOpen = createWindowOpenHandler((url) => openedUrls.push(url));

  for (const url of [
    'https://example.com/releases/latest',
    'http://github.com/example/tt-turnier/releases/latest',
    'https://github.com.example.com/releases/latest',
  ]) {
    assert.deepEqual(handleWindowOpen({ url }), { action: 'deny' });
  }
  assert.deepEqual(openedUrls, []);
});

test('returns clear feedback when a release link cannot open in the browser', async () => {
  const result = await openExternalSafely(
    'https://github.com/example/tt-turnier/releases/latest',
    async () => { throw new Error('No browser is configured'); },
  );
  assert.deepEqual(result, {
    success: false,
    message: 'Der Link konnte nicht im Browser geöffnet werden. Prüfe die Standardbrowser-Einstellungen.',
  });
});

test('does not open non-GitHub URLs through the desktop bridge', async () => {
  let opened = false;
  const result = await openExternalSafely('https://example.com', async () => { opened = true; });
  assert.equal(opened, false);
  assert.equal(result.success, false);
  assert.match(result.message, /nicht auf GitHub/);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveReleaseNotesUrl } = require('./release-config.cjs');

test('release builds require a valid GitHub repository', () => {
  assert.throws(
    () => resolveReleaseNotesUrl('not/a/repository/path', true),
    /Release builds require GITHUB_REPOSITORY/,
  );
  assert.throws(
    () => resolveReleaseNotesUrl(undefined, true),
    /Release builds require GITHUB_REPOSITORY/,
  );
});

test('development builds remain usable without release metadata', () => {
  assert.equal(resolveReleaseNotesUrl(undefined, false), null);
  assert.equal(resolveReleaseNotesUrl('not/a/repository/path', false), null);
});

test('valid release metadata produces the latest release notes link', () => {
  assert.equal(
    resolveReleaseNotesUrl('example/tt-turnier', true),
    'https://github.com/example/tt-turnier/releases/latest',
  );
});

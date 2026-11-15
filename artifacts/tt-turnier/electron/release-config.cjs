const RELEASE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function resolveReleaseNotesUrl(repository, isReleaseBuild) {
  const normalizedRepository = typeof repository === 'string' ? repository.trim() : '';
  const validRepository = RELEASE_REPOSITORY.test(normalizedRepository);
  if (isReleaseBuild && !validRepository) {
    throw new Error('Release builds require GITHUB_REPOSITORY in owner/repository format.');
  }
  return validRepository
    ? `https://github.com/${normalizedRepository}/releases/latest`
    : null;
}

module.exports = { resolveReleaseNotesUrl };

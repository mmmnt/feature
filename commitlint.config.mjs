// Commit titles decide releases (release.yml turns feat/fix/perf/refactor into a changeset), so they
// follow Conventional Commits, as in Moment. Feature's titles and bodies run long on purpose, and a
// subject often starts with a spec id or an error code (SPEC-RT-017, OPTIONAL_UNSTATED), so the
// length and subject-case rules of the conventional preset are off. Checked by .githooks/commit-msg.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'test', 'spec', 'docs', 'ci', 'build', 'chore', 'revert'],
    ],
    'header-max-length': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'subject-case': [0],
  },
};

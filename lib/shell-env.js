'use strict';

/**
 * Environment for the debug shell. Drops everything the session user must not reuse:
 * the secret list, the relay token and the job's OIDC request credentials (with those a
 * user could mint job-scoped OIDC tokens for other audiences, such as cloud roles).
 */
const STRIPPED = [
  'GITERA_DEBUG_SECRETS',
  'GITERA_RUNNER_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];

function buildShellEnv(source) {
  const env = { ...source, TERM: 'xterm-256color' };
  for (const name of STRIPPED) delete env[name];
  return env;
}

module.exports = { buildShellEnv, STRIPPED };

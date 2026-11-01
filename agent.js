#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS action, runs without a build step */
'use strict';

/**
 * gitera/debug runner agent. Pauses the job (max 15 minutes) and relays an interactive
 * shell to the Gitera dashboard over outbound HTTPS only: no open ports, no third-party
 * tunnel. Identity comes from the job's GitHub OIDC token, so no Gitera secret is stored
 * in the repository. The step never changes the job result.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { createMasker } = require('./lib/mask');
const { buildShellEnv } = require('./lib/shell-env');
const { createOutbox } = require('./lib/outbox');

const MAX_MINUTES = 15;
const POLL_WAIT_MS = 9000;
const MAX_CHUNK = 16 * 1024;
const MAX_BATCH = 50;
const MAX_DIFF_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_GRACE_MS = 5_000;
const OIDC_AUDIENCE = 'gitera';

// Fixed on purpose: the job's OIDC token (audience "gitera") is sent here, and a server that
// received it could replay it to Gitera to open sessions as this job.
const baseUrl = 'https://app.gitera.io';
const mode = process.env.GITERA_DEBUG_MODE === 'armed' ? 'armed' : 'failure';
const timeoutMinutes = Math.min(Math.max(Number(process.env.GITERA_DEBUG_TIMEOUT) || MAX_MINUTES, 1), MAX_MINUTES);
const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const masker = createMasker(process.env.GITERA_DEBUG_SECRETS || '{}');

const log = (message) => console.log(`[gitera/debug] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) return null;
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('audience', OIDC_AUDIENCE);
  const response = await fetch(requestUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`OIDC token request failed: ${response.status}`);
  const body = await response.json();
  return body.value || null;
}

/** Every request is time-bounded, so a stalled connection cannot hold the runner past its deadline. */
async function api(path, { method = 'GET', token, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

/**
 * Interactive shell on a pseudo-terminal. Prefers the Python bridge, whose control pipe
 * (fd 3) lets the browser resize the pty; falls back to util-linux `script` on Linux
 * without python3, where the size stays fixed. Returns { proc, resize }.
 */
function startShell() {
  const env = buildShellEnv(process.env);
  const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

  if (has('python3')) {
    env.BASH_SILENCE_DEPRECATION_WARNING = '1';
    const proc = spawn('python3', [path.join(__dirname, 'lib', 'pty_bridge.py')], {
      cwd: workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const control = proc.stdio[3];
    control.on('error', () => undefined);
    return { proc, resize: (cols, rows) => control.write(`${cols} ${rows}\n`) };
  }
  // BSD `script` (macOS) refuses a socket stdin, so macOS needs python3.
  if (process.platform === 'linux' && has('script')) {
    return { proc: spawn('script', ['-qfec', 'bash -i', '/dev/null'], { cwd: workspace, env }), resize: null };
  }
  return null;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * MAX_DIFF_BYTES });
}

/** Tracked changes plus untracked files, as one unified diff. The index is not modified. */
function generateDiff() {
  const parts = [];
  const tracked = run('git', ['-c', 'core.quotepath=off', 'diff', 'HEAD']);
  if (tracked.status !== 0) return { patch: `# git diff failed: ${(tracked.stderr || '').trim()}\n`, truncated: false };
  parts.push(tracked.stdout);

  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const file of (untracked.stdout || '').split('\0').filter(Boolean)) {
    // --no-index exits 1 when files differ; that is the normal case here.
    parts.push(run('git', ['diff', '--no-index', '--', '/dev/null', file]).stdout || '');
  }

  let patch = masker.mask(parts.join(''));
  let truncated = false;
  // The relay caps diffs in UTF-8 bytes; cut on a byte boundary and drop a split character.
  if (Buffer.byteLength(patch, 'utf8') > MAX_DIFF_BYTES) {
    patch = Buffer.from(patch, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8').replace(/\uFFFD$/, '');
    truncated = true;
  }
  return { patch, truncated };
}

function chunk(text) {
  const out = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK) out.push(text.slice(i, i + MAX_CHUNK));
  return out;
}

async function main() {
  if (process.platform === 'win32') {
    log('Windows runners are not supported yet; continuing.');
    return;
  }

  let oidc;
  try {
    oidc = await getOidcToken();
  } catch (error) {
    log(`Could not get an OIDC token: ${error.message}`);
    return;
  }
  if (!oidc) {
    log('No OIDC token. Add `permissions: id-token: write` to the job; continuing without a debug session.');
    return;
  }

  const opened = await api('/api/debug-runner', {
    method: 'POST',
    token: oidc,
    // Matrix legs share GITHUB_JOB; RUNNER_NAME is unique among running jobs.
    body: { jobName: process.env.GITHUB_JOB || 'job', mode, runnerName: process.env.RUNNER_NAME || null },
  });
  if (opened.status !== 201) {
    if (opened.data.status !== 'not_armed') log(`No debug session: ${opened.data.reason || opened.data.error || opened.status}`);
    return;
  }

  const { sessionId, runnerToken, expiresAt, url } = opened.data;
  const deadline = Math.min(Date.parse(expiresAt), Date.now() + timeoutMinutes * 60_000);
  process.env.GITERA_RUNNER_TOKEN = runnerToken;

  console.log(`::notice title=Gitera debug session::Runner paused for up to ${timeoutMinutes} minutes. Open ${url}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Gitera debug session\n\n[Open the runner terminal](${url}) (expires ${new Date(deadline).toISOString()})\n`);
  }
  log(`Masking ${masker.secretCount} secret value(s). Session ${sessionId}.`);

  const started = startShell();
  if (!started) {
    log('No pseudo-terminal available on this runner; continuing.');
    return;
  }

  const shell = started.proc;
  let stopped = false;
  let exitCode = null;
  const decoder = new StringDecoder('utf8');

  // Output goes out as soon as it arrives, in order, and is retried until the relay takes it.
  const outbox = createOutbox({
    post: async (batch, batchId) =>
      (await api(`/api/debug-runner/${sessionId}`, { method: 'POST', token: runnerToken, body: { messages: batch, batchId } })).status,
    maxBatch: MAX_BATCH,
    sleep,
    log,
    onStop: (reason) => {
      log(`Stopping: ${reason}.`);
      stopped = true;
    },
  });

  // The masker may hold back a possible secret prefix. It stays held until more output
  // resolves it: a quiet pause proves nothing, so there is no time-based release.
  const enqueue = (text) => {
    if (text) outbox.enqueue(chunk(text).map((d) => ({ t: 'o', d })));
  };
  const onData = (data) => enqueue(masker.push(decoder.write(data)));
  shell.stdout.on('data', onData);
  shell.stderr.on('data', onData);
  shell.on('exit', (code) => {
    exitCode = code;
    stopped = true;
  });

  let cursor = 0;
  while (!stopped && Date.now() < deadline) {
    let res;
    try {
      const wait = Math.max(0, Math.min(POLL_WAIT_MS, deadline - Date.now()));
      res = await api(`/api/debug-runner/${sessionId}?cursor=${cursor}&wait=${wait}`, { token: runnerToken, timeoutMs: wait + REQUEST_TIMEOUT_MS });
    } catch (error) {
      log(`poll failed: ${error.message}`);
      await sleep(1000);
      continue;
    }
    if (res.status !== 200) break;
    cursor = res.data.cursor;
    for (const message of res.data.messages || []) {
      if (message.t === 'i') shell.stdin.write(message.d);
      else if (message.t === 'resize') started.resize?.(message.cols, message.rows);
      else if (message.t === 'diff') {
        const { patch, truncated } = generateDiff();
        outbox.enqueue([{ t: 'diff', d: patch, truncated }]);
      } else if (message.t === 'end') stopped = true;
    }
    if (res.data.status === 'ended') stopped = true;
  }

  // Kill the shell first: cleanup must not wait on the network past the deadline.
  if (!shell.killed && exitCode === null) shell.kill('SIGKILL');
  enqueue(masker.flush());
  outbox.enqueue([{ t: 'exit', code: exitCode }]);
  await outbox.drain(CLEANUP_GRACE_MS);
  log('Debug session closed; the job continues.');
}

main()
  .catch((error) => log(`Unexpected error: ${error.message}`))
  .finally(() => process.exit(0));

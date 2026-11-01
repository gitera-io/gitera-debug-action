'use strict';

/**
 * Ordered, retrying sender for runner -> relay messages. One POST at a time keeps order;
 * whatever piles up while a POST is in flight rides along in the next one. A batch leaves
 * the queue only after a 2xx, so a network blip or 5xx retries instead of dropping output.
 * 401/410 (session over) and 413 (relay full) stop the session; so does a relay that keeps
 * failing, rather than silently losing what the user sees.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS action, no build step
const { randomUUID } = require('crypto');

const STOP_STATUSES = new Set([401, 410, 413]);

const newBatchId = () => randomUUID();
const MAX_RETRIES = 5;

function createOutbox({ post, maxBatch = 50, sleep, log = () => {}, onStop = () => {} }) {
  const queue = [];
  let sending = null;
  let stopped = false;

  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    onStop(reason);
  };

  // The batch being sent. It stays fixed, with its ID, until the relay accepts it: the relay
  // appends each ID once, so a retry after a lost response is not shown twice.
  let current = null;

  async function run() {
    let failures = 0;
    while ((current || queue.length > 0) && !stopped) {
      if (!current) {
        const messages = queue.slice(0, maxBatch);
        current = { id: newBatchId(), messages };
      }
      let status = 0;
      try {
        status = await post(current.messages, current.id);
      } catch (error) {
        log(`send failed: ${error.message}`);
      }
      if (status >= 200 && status < 300) {
        queue.splice(0, current.messages.length);
        current = null;
        failures = 0;
      } else if (STOP_STATUSES.has(status)) {
        stop(status === 413 ? 'relay message limit reached' : 'session ended');
      } else {
        failures += 1;
        if (failures > MAX_RETRIES) {
          stop(`relay unreachable (last status ${status || 'network error'})`);
        } else {
          await sleep(Math.min(250 * 2 ** (failures - 1), 4000));
        }
      }
    }
  }

  function pump() {
    if (!sending) sending = run().finally(() => (sending = null));
    return sending;
  }

  return {
    enqueue(messages) {
      if (stopped || messages.length === 0) return;
      queue.push(...messages);
      void pump();
    },
    /** Sends what is queued; gives up after `timeoutMs` so cleanup never hangs. */
    async drain(timeoutMs) {
      if (queue.length > 0 && !stopped) void pump();
      if (!sending) return;
      let timer;
      const timeout = new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)));
      await Promise.race([sending, timeout]);
      clearTimeout(timer);
    },
    get stopped() {
      return stopped;
    },
    get pending() {
      return queue.length;
    },
  };
}

module.exports = { createOutbox, MAX_RETRIES };

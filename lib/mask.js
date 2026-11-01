'use strict';

/**
 * Streaming secret masker for gitera/debug. Masks every secret value (and its base64 and
 * URL-encoded forms) with ***. Text that could be the start of a secret split across two
 * output chunks is held back until the next chunk or flush, so no partial secret leaks.
 */

const MASK = '***';

function collectSecrets(secretsJson) {
  let parsed = {};
  if (typeof secretsJson === 'string' && secretsJson.trim()) {
    try {
      parsed = JSON.parse(secretsJson);
    } catch {
      parsed = {};
    }
  } else if (secretsJson && typeof secretsJson === 'object') {
    parsed = secretsJson;
  }

  const values = new Set();
  // Every supplied value is masked, however short. Values are trimmed: the raw value with
  // its surrounding whitespace still contains the trimmed one, so it is masked too.
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) values.add(value);
  };
  for (const raw of Object.values(parsed)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    add(trimmed);
    // Multi-line secrets (keys, certs) are masked line by line, like GitHub does.
    for (const line of trimmed.split(/\r?\n/)) add(line.trim());
    add(Buffer.from(trimmed).toString('base64'));
    add(encodeURIComponent(trimmed));
  }
  // Longest first, so a secret that contains another is masked whole.
  return Array.from(values).sort((a, b) => b.length - a.length);
}

function maskAll(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out;
}

/** Length of the longest suffix of `text` that is a proper prefix of some secret. */
function pendingPrefixLength(text, secrets) {
  let longest = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, text.length);
    for (let len = max; len > longest; len -= 1) {
      if (secret.startsWith(text.slice(text.length - len))) {
        longest = len;
        break;
      }
    }
  }
  return longest;
}

function createMasker(secretsJson) {
  const secrets = collectSecrets(secretsJson);
  let carry = '';

  return {
    secretCount: secrets.length,
    /** Returns text that is safe to send now; may hold back a possible secret prefix. */
    push(chunk) {
      const masked = maskAll(carry + chunk, secrets);
      const hold = pendingPrefixLength(masked, secrets);
      carry = masked.slice(masked.length - hold);
      return masked.slice(0, masked.length - hold);
    },
    /**
     * End of stream. Held text is always a possible secret prefix, so it is masked rather
     * than released: nothing later can prove it harmless. Call this only when output ends;
     * releasing on a timer would leak the prefix of a secret printed in two pieces.
     */
    flush() {
      const rest = carry;
      carry = '';
      return rest ? MASK : '';
    },
    /** One-shot masking for complete text such as a diff. */
    mask(text) {
      return maskAll(text, secrets);
    },
  };
}

module.exports = { createMasker, collectSecrets, MASK };

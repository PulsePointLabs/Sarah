import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeMalformedUnicodeString,
  sanitizeProviderPayload,
} from './sanitizeProviderPayload.js';

test('preserves ordinary text and valid emoji surrogate pairs', () => {
  const input = 'Sarah says hello 👋 and stays warm 💜';
  assert.equal(sanitizeMalformedUnicodeString(input), input);
});

test('replaces an isolated low surrogate without changing surrounding text', () => {
  assert.equal(
    sanitizeMalformedUnicodeString(`before\uDC00after`),
    'before\uFFFDafter',
  );
});

test('replaces an isolated high surrogate without consuming the next character', () => {
  assert.equal(
    sanitizeMalformedUnicodeString(`before\uD83Dafter`),
    'before\uFFFDafter',
  );
});

test('sanitizes nested provider payload strings without mutating the source', () => {
  const source = {
    model: 'claude-sonnet',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `valid 💜 malformed \uDC00 context` },
      ],
    }],
  };

  const sanitized = sanitizeProviderPayload(source);

  assert.notEqual(sanitized, source);
  assert.equal(source.messages[0].content[0].text.includes('\uDC00'), true);
  assert.equal(
    sanitized.messages[0].content[0].text,
    'valid 💜 malformed \uFFFD context',
  );
});

test('produces provider JSON with no isolated surrogate escapes', () => {
  const sanitized = sanitizeProviderPayload({
    prompt: `high \uD83D low \uDC00 pair 💜`,
  });
  const json = JSON.stringify(sanitized);

  assert.equal(json.includes('\\ud83d'), false);
  assert.equal(json.includes('\\udc00'), false);
  assert.equal(JSON.parse(json).prompt, 'high \uFFFD low \uFFFD pair 💜');
});

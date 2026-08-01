const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * JavaScript strings can contain isolated UTF-16 surrogate code units.
 * JSON.stringify preserves them as \uXXXX escapes, but provider APIs reject
 * those escapes because they are not valid Unicode scalar values.
 *
 * Keep valid surrogate pairs (including emoji) unchanged and replace only
 * malformed high/low surrogates at the final provider boundary.
 */
export function sanitizeMalformedUnicodeString(value = '') {
  const input = String(value);
  let output = '';

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = input.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += REPLACEMENT_CHARACTER;
      }
      continue;
    }

    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      output += REPLACEMENT_CHARACTER;
      continue;
    }

    output += input[index];
  }

  return output;
}

export function sanitizeProviderPayload(value, seen = new WeakMap()) {
  if (typeof value === 'string') {
    return sanitizeMalformedUnicodeString(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const sanitized = [];
    seen.set(value, sanitized);
    value.forEach((item) => sanitized.push(sanitizeProviderPayload(item, seen)));
    return sanitized;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return seen.get(value);
    const sanitized = {};
    seen.set(value, sanitized);
    Object.entries(value).forEach(([key, item]) => {
      sanitized[sanitizeMalformedUnicodeString(key)] = sanitizeProviderPayload(item, seen);
    });
    return sanitized;
  }

  return value;
}

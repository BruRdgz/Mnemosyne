import { fnv1a64 } from './ids.js';

export const FINGERPRINT_VERSION = 1;

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function fingerprintValue(value, namespace = 'value') {
  return `fp${FINGERPRINT_VERSION}_${fnv1a64(`${namespace}:v${FINGERPRINT_VERSION}:${stableStringify(value)}`)}`;
}

export function createMessageSourceRef(message, messageIndex) {
  if (!Number.isInteger(messageIndex) || messageIndex < 0) throw new TypeError('messageIndex must be a non-negative integer');
  const activeSwipe = Number.isInteger(message.swipeId ?? message.swipe_id) ? Number(message.swipeId ?? message.swipe_id) : 0;
  const identity = {
    messageIndex,
    activeSwipe,
    role: String(message.role ?? (message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'))),
    name: String(message.name ?? ''),
    text: String(message.text ?? message.mes ?? ''),
  };
  return Object.freeze({
    messageIndex,
    messageFingerprint: fingerprintValue(identity, 'message-source'),
    activeSwipe,
  });
}

export function createSourceRange(messages, startIndex = 0) {
  if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('Source range requires at least one message');
  const refs = messages.map((message, offset) => createMessageSourceRef(message, startIndex + offset));
  return Object.freeze({
    first: refs[0],
    last: refs.at(-1),
    rangeFingerprint: fingerprintValue({ version: FINGERPRINT_VERSION, refs }, 'source-range'),
  });
}

import { createMessageSourceRef, fingerprintValue } from './fingerprint.js';

export const TURN_BUNDLE_VERSION = 1;

function roleOf(message) {
  return String(message?.role ?? (message?.is_user ? 'user' : (message?.is_system ? 'system' : 'assistant')));
}

function originalOf(message) {
  return message?.original && typeof message.original === 'object' ? message.original : message;
}

function normalizedNarrativeText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function mediaProjection(message) {
  const original = originalOf(message) ?? {};
  const extra = original.extra ?? message?.extra ?? {};
  const candidates = [
    original.attachments, original.image, original.file,
    extra.attachments, extra.media, extra.image, extra.file,
  ].filter(value => value !== undefined && value !== null);
  return candidates.map(projectMediaValue);
}

function projectMediaValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(projectMediaValue);
  if (typeof value !== 'object') return String(value);
  const relevantKeys = [
    'url', 'src', 'path', 'name', 'title', 'type', 'mimeType', 'mime_type',
    'caption', 'description', 'text', 'hash', 'digest', 'size', 'width', 'height',
  ];
  const projected = {};
  for (const key of relevantKeys) if (value[key] !== undefined) projected[key] = projectMediaValue(value[key]);
  return Object.keys(projected).length ? projected : value;
}

function canonicalMessage(message, position, { narrative = false } = {}) {
  const original = originalOf(message) ?? {};
  const index = Number.isInteger(message?.index) ? message.index : position;
  const text = message?.text ?? message?.mes ?? original.mes ?? '';
  const swipeId = Number.isInteger(message?.swipeId ?? message?.swipe_id ?? original.swipe_id)
    ? Number(message?.swipeId ?? message?.swipe_id ?? original.swipe_id)
    : 0;
  return {
    version: TURN_BUNDLE_VERSION,
    index,
    stableId: String(message?.id ?? original.id ?? original.extra?.message_id ?? ''),
    role: roleOf(message),
    name: narrative ? normalizedNarrativeText(message?.name ?? original.name ?? '') : String(message?.name ?? original.name ?? ''),
    text: narrative ? normalizedNarrativeText(text) : String(text),
    swipeId,
    narratorType: String(original.extra?.type ?? message?.extra?.type ?? ''),
    media: mediaProjection(message),
  };
}

function makeBundle(messages, start, end) {
  const slice = messages.slice(start, end + 1);
  const firstIndex = Number.isInteger(slice[0]?.index) ? slice[0].index : start;
  const lastIndex = Number.isInteger(slice.at(-1)?.index) ? slice.at(-1).index : end;
  const roles = slice.map(roleOf);
  const firstUser = roles.indexOf('user');
  const hasAssistantAfterUser = firstUser >= 0 && roles.slice(firstUser + 1).includes('assistant');
  const kind = firstUser < 0 ? 'opening' : hasAssistantAfterUser ? 'exchange' : 'incomplete_user';
  const exact = slice.map((message, offset) => canonicalMessage(message, firstIndex + offset));
  const narrative = slice.map((message, offset) => canonicalMessage(message, firstIndex + offset, { narrative: true }));
  const sourceHash = fingerprintValue({ version: TURN_BUNDLE_VERSION, exact }, 'turn-bundle-source');
  const narrativeHash = fingerprintValue({ version: TURN_BUNDLE_VERSION, narrative }, 'turn-bundle-narrative');
  return Object.freeze({
    id: fingerprintValue({ version: TURN_BUNDLE_VERSION, firstIndex, lastIndex, sourceHash }, 'turn-bundle-id'),
    hashVersion: TURN_BUNDLE_VERSION,
    firstIndex,
    lastIndex,
    complete: kind !== 'incomplete_user',
    kind,
    sourceHash,
    narrativeHash,
    messageRefs: Object.freeze(slice.map((message, offset) => createMessageSourceRef(message, firstIndex + offset))),
  });
}

export function createTurnBundles(messages) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  if (!messages.length) return Object.freeze([]);
  const bundles = [];
  let start = 0;
  let sawUser = false;
  let sawAssistantAfterUser = false;

  for (let position = 0; position < messages.length; position += 1) {
    const role = roleOf(messages[position]);
    if (position > start && role === 'user' && sawUser && sawAssistantAfterUser) {
      bundles.push(makeBundle(messages, start, position - 1));
      start = position;
      sawUser = false;
      sawAssistantAfterUser = false;
    }
    if (role === 'user') sawUser = true;
    else if (role === 'assistant' && sawUser) sawAssistantAfterUser = true;
  }
  bundles.push(makeBundle(messages, start, messages.length - 1));
  return Object.freeze(bundles);
}

export function turnBundleFingerprint(bundles) {
  return fingerprintValue((bundles ?? []).map(bundle => ({
    firstIndex: bundle.firstIndex,
    lastIndex: bundle.lastIndex,
    sourceHash: bundle.sourceHash,
    narrativeHash: bundle.narrativeHash,
    complete: bundle.complete,
  })), 'turn-bundle-range');
}

export function auditTurnBundleIntegrity(expectedBundles, currentMessages) {
  if (!Array.isArray(expectedBundles)) throw new TypeError('expectedBundles must be an array');
  const actualBundles = createTurnBundles(currentMessages);
  const exactChanged = [];
  const narrativeChanged = [];
  const count = Math.max(expectedBundles.length, actualBundles.length);
  for (let index = 0; index < count; index += 1) {
    const expected = expectedBundles[index];
    const actual = actualBundles[index];
    const identity = expected?.id ?? actual?.id ?? `bundle:${index}`;
    if (!expected || !actual
      || expected.firstIndex !== actual.firstIndex
      || expected.lastIndex !== actual.lastIndex
      || expected.sourceHash !== actual.sourceHash) exactChanged.push(identity);
    if (!expected || !actual
      || expected.firstIndex !== actual.firstIndex
      || expected.lastIndex !== actual.lastIndex
      || expected.narrativeHash !== actual.narrativeHash) narrativeChanged.push(identity);
  }
  return Object.freeze({
    ok: exactChanged.length === 0,
    narrativeOk: narrativeChanged.length === 0,
    cosmeticOnly: exactChanged.length > 0 && narrativeChanged.length === 0,
    exactChanged: Object.freeze(exactChanged),
    narrativeChanged: Object.freeze(narrativeChanged),
    actualBundles,
  });
}


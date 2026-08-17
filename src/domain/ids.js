const ENTITY_ID_PATTERN = /^ent_[0-9a-f]{16}$/;
const SEGMENT_ID_PATTERN = /^seg_[0-9a-f]{16}$/;

function fnv1a64(input) {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(String(input).normalize('NFC'));
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function entityIdFromSeed(seed) {
  if (typeof seed !== 'string' || !seed.trim()) throw new TypeError('EntityId seed must be non-empty');
  return `ent_${fnv1a64(`entity:v1:${seed}`)}`;
}

export function segmentIdFromSource(rangeFingerprint) {
  if (typeof rangeFingerprint !== 'string' || !rangeFingerprint) throw new TypeError('Range fingerprint is required');
  return `seg_${fnv1a64(`segment:v1:${rangeFingerprint}`)}`;
}

export function assertEntityId(value) {
  if (!ENTITY_ID_PATTERN.test(value)) throw new TypeError(`Invalid EntityId: ${value}`);
  return value;
}

export function assertSegmentId(value) {
  if (!SEGMENT_ID_PATTERN.test(value)) throw new TypeError(`Invalid SegmentId: ${value}`);
  return value;
}

export { ENTITY_ID_PATTERN, SEGMENT_ID_PATTERN, fnv1a64 };

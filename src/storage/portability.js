import { SCHEMA_VERSION, validateMemorySegment } from '../domain/schema.js';
import { ENVELOPE_VERSION } from '../core/constants.js';
import { validateRebuildSession } from '../rebuild/rebuild-session.js';
import { safeDetails } from '../observability/telemetry-logger.js';

export function exportSemanticMemory(envelope) {
  validateEnvelope(envelope, { expectedChatId: envelope?.chatId });
  return JSON.stringify(envelope, null, 2);
}

export function importSemanticMemory(serialized, { expectedChatId }) {
  let envelope;
  try { envelope = typeof serialized === 'string' ? JSON.parse(serialized) : structuredClone(serialized); }
  catch { throw new TypeError('Import is not valid JSON'); }
  return validateEnvelope(envelope, { expectedChatId });
}

export function validateEnvelope(envelope, { expectedChatId } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('Semantic-memory envelope must be an object');
  if (envelope.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported semantic schema version: ${envelope.schemaVersion}`);
  if (!envelope.chatId) throw new Error('Semantic-memory envelope requires chatId');
  if (expectedChatId !== undefined && String(envelope.chatId) !== String(expectedChatId)) throw new Error('Import belongs to a different chat');
  if (!Array.isArray(envelope.segments)) throw new TypeError('Semantic-memory segments must be an array');
  for (const segment of envelope.segments) validateMemorySegment(segment, { throwOnError: true });
  for (const session of envelope.rebuildSessions ?? []) validateRebuildSession(session, { expectedChatId: envelope.chatId });
  return { ...structuredClone(envelope), envelopeVersion: ENVELOPE_VERSION, rebuildSessions: structuredClone(envelope.rebuildSessions ?? []) };
}

export function exportDiagnostics({ metrics = [], telemetry = [], benchmark = null, includeNarrative = false, semanticMemory = null } = {}) {
  const report = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    metrics: sanitize(metrics),
    telemetry: sanitize(telemetry),
    benchmark: sanitize(benchmark),
  };
  if (includeNarrative && semanticMemory) report.semanticMemory = structuredClone(semanticMemory);
  return report;
}

function sanitize(value, key = '') {
  if (['error', 'errors', 'validationerror', 'validationerrors', 'warning', 'warnings'].includes(String(key).toLowerCase())) return safeDetails(value, key);
  if (Array.isArray(value)) return value.map(item => sanitize(item, key));
  if (!value || typeof value !== 'object') return value;
  const forbidden = new Set(['text', 'mes', 'content', 'prompt', 'summary', 'synopsis', 'raw', 'semanticMemory']);
  return Object.fromEntries(Object.entries(value).filter(([childKey]) => !forbidden.has(childKey)).map(([childKey, nested]) => [childKey, sanitize(nested, childKey)]));
}

export class RebuildManager {
  #buildSegments;
  #lexicalIndex;
  #metrics;

  constructor({ buildSegments, lexicalIndex, metrics = null }) {
    if (typeof buildSegments !== 'function') throw new TypeError('buildSegments is required');
    this.#buildSegments = buildSegments;
    this.#lexicalIndex = lexicalIndex;
    this.#metrics = metrics;
  }

  async full(rawMessages, existingSegments = [], { fromMessageIndex = 0 } = {}) {
    const finish = this.#metrics?.measure('semantic_rebuild', { sourceMessageCount: rawMessages.length, fromMessageIndex });
    const preservedManual = existingSegments.filter(segment => segment.manuallyEdited);
    const rebuilt = await this.#buildSegments(rawMessages, { fromMessageIndex });
    const manualBySource = new Map(preservedManual.map(segment => [segment.source.rangeFingerprint, segment]));
    const merged = rebuilt.map(segment => manualBySource.get(segment.source.rangeFingerprint) ?? segment);
    for (const manual of preservedManual) if (!merged.some(segment => segment.source.rangeFingerprint === manual.source.rangeFingerprint)) merged.push(manual);
    merged.sort((a, b) => a.source.first.messageIndex - b.source.first.messageIndex);
    finish?.({ status: 'success', segmentCount: merged.length, manualPreservedCount: preservedManual.length });
    return merged;
  }

  indexesOnly(segments) {
    const finish = this.#metrics?.measure('index_only_rebuild', { segmentCount: segments.length });
    const result = this.#lexicalIndex.rebuild(segments);
    finish?.({ status: 'success', documentCount: result.documentCount, serializedBytes: result.serializedBytes });
    return result;
  }
}

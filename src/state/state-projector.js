import { commitmentKey } from './narrative-reducer.js';

const ENTITY_ID_PATTERN = /^ent_[0-9a-f]{16}$/;

function scalar(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join(', ');
  if (typeof value === 'object') return flatten(value).map(([path, item]) => `${path}=${scalar(item)}`).join('; ');
  return '';
}

function flatten(value, prefix = '') {
  const result = [];
  for (const [key, item] of Object.entries(value ?? {})) {
    if (item === undefined || item === null || item === '') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'object' && !Array.isArray(item)) result.push(...flatten(item, path));
    else result.push([path, item]);
  }
  return result;
}

function entityLookup(records = []) {
  const lookup = new Map();
  const values = records instanceof Map ? [...records.values()] : (Array.isArray(records) ? records : []);
  for (const record of values) {
    if (!record || typeof record !== 'object' || !record.id) continue;
    const canonicalName = String(record.canonicalName ?? record.name ?? '').trim();
    if (canonicalName) lookup.set(record.id, canonicalName);
  }
  return lookup;
}

function displayEntity(value, entities, fallback = 'unknown character') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (entities.has(text)) return entities.get(text);
  return ENTITY_ID_PATTERN.test(text) ? fallback : text;
}

function segmentInfo(segments = []) {
  const sorted = [...segments].filter(segment => segment?.id).sort((left, right) => {
    const leftIndex = left.source?.first?.messageIndex ?? left.firstIndex ?? Infinity;
    const rightIndex = right.source?.first?.messageIndex ?? right.firstIndex ?? Infinity;
    return leftIndex - rightIndex || String(left.id).localeCompare(String(right.id));
  });
  const result = new Map();
  sorted.forEach((segment, index) => {
    const first = segment.source?.first?.messageIndex ?? segment.firstIndex;
    const last = segment.source?.last?.messageIndex ?? segment.lastIndex;
    result.set(segment.id, {
      segmentId: segment.id,
      segmentOrdinal: Number.isInteger(segment.segmentOrdinal) ? segment.segmentOrdinal : index + 1,
      firstMessage: Number.isInteger(first) ? first : null,
      lastMessage: Number.isInteger(last) ? last : null,
      sourceFingerprint: segment.source?.rangeFingerprint ?? null,
    });
  });
  return result;
}

function normalizedNegativeKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function relationshipStateKey(participants = []) {
  return participants.map(value => String(value)).sort().join('|');
}

function provenanceMap(segments = [], infos = new Map()) {
  const latest = new Map();
  const remember = (key, segmentId, fallbackOrdinal) => {
    if (!key) return;
    const info = infos.get(segmentId) ?? { segmentId, segmentOrdinal: fallbackOrdinal };
    latest.set(key, info);
  };
  const ordered = [...segments].filter(segment => segment?.summary && segment?.id).sort((left, right) => {
    const leftIndex = left.source?.first?.messageIndex ?? left.firstIndex ?? Infinity;
    const rightIndex = right.source?.first?.messageIndex ?? right.firstIndex ?? Infinity;
    return leftIndex - rightIndex || String(left.id).localeCompare(String(right.id));
  });
  ordered.forEach((segment, index) => {
    const summary = segment.summary ?? {};
    const segmentId = segment.id;
    const ordinal = infos.get(segmentId)?.segmentOrdinal ?? index + 1;
    for (const change of summary.stateChanges ?? []) {
      remember(`character:${change.subject}`, segmentId, ordinal);
    }
    for (const change of summary.knowledgeChanges ?? []) {
      remember(`character:${change.holder}`, segmentId, ordinal);
    }
    for (const change of summary.relationshipChanges ?? []) {
      remember(`relationship:${relationshipStateKey(change.participants)}`, segmentId, ordinal);
      for (const participant of change.participants ?? []) remember(`character:${participant}`, segmentId, ordinal);
    }
    for (const change of summary.commitments ?? []) {
      let id = change.id;
      try { id ??= commitmentKey(change); } catch { /* Invalid summaries are not projected. */ }
      remember(`commitment:${id}`, segmentId, ordinal);
      remember(`character:${change.actor}`, segmentId, ordinal);
      if (change.toward) remember(`character:${change.toward}`, segmentId, ordinal);
    }
    for (const change of summary.threads ?? []) remember(`thread:${change.key}`, segmentId, ordinal);
    for (const observation of summary.observations ?? []) {
      const key = observation.predicate ?? observation.description;
      const scope = observation.epistemicScope;
      if (scope === 'world' || scope === 'narrator') remember(`${scope === 'world' ? 'world_fact' : 'narrator_fact'}:${key}`, segmentId, ordinal);
    }
    for (const negative of summary.salientNegatives ?? []) remember(`salient_negative:${normalizedNegativeKey(negative.proposition)}`, segmentId, ordinal);
  });
  return latest;
}

function formatChronology(value) {
  if (!value) return '';
  const label = Number.isInteger(value.segmentOrdinal) ? `S${String(value.segmentOrdinal).padStart(2, '0')}` : '';
  const first = Number.isInteger(value.firstMessage) ? value.firstMessage : null;
  const last = Number.isInteger(value.lastMessage) ? value.lastMessage : null;
  const range = first !== null && last !== null ? `msgs ${first}–${last}` : first !== null ? `msg ${first}` : '';
  const parts = [label, range].filter(Boolean);
  return parts.length ? `[${parts.join(' · ')}]` : '';
}

function add(items, id, kind, text, priority, chronology = null) {
  if (!text) return;
  const prefix = formatChronology(chronology);
  items.push({
    id: `state:${kind}:${id}`,
    text: prefix ? `${prefix} ${text}` : text,
    rawText: text,
    priority,
    evidence: 'explicit',
    chronology: chronology ? structuredClone(chronology) : null,
  });
}

function renderCommitment(value, entities) {
  const actor = displayEntity(value.actor, entities);
  const toward = value.toward ? ` to ${displayEntity(value.toward, entities)}` : '';
  return `Commitment (${value.status ?? 'active'}): ${actor}${toward} — ${value.content ?? 'unspecified commitment'}`;
}

function renderRelationship(value, id, entities) {
  const participants = (value.participants ?? id.split('|')).map(item => displayEntity(item, entities)).join(' ↔ ');
  const dimensions = Object.entries(value).filter(([key]) => key !== 'participants').map(([key, item]) => `${key}=${scalar(item)}`).join('; ');
  return dimensions ? `Relationship ${participants}: ${dimensions}` : '';
}

function renderCharacter(value, id, entities) {
  const details = flatten(value).filter(([path]) => path !== 'entityId').map(([path, item]) => `${path}=${scalar(item)}`).join('; ');
  const name = displayEntity(value.entityId ?? id, entities);
  return details ? `Character ${name}: ${details}` : '';
}

function renderFact(prefix, value, id, entities) {
  const description = value.description ?? value.predicate ?? value.proposition ?? scalar(value);
  return description ? `${prefix}: ${description}${value.subject ? ` [${displayEntity(value.subject, entities)}]` : ''}` : `${prefix}: ${id}`;
}

function chronologyFor(provenance, kind, id) {
  return provenance.get(`${kind}:${id}`) ?? null;
}

/**
 * Temporarily age out stale active commitments from the projected state.
 *
 * This is deliberately a projection-only operation.  The normalized segment,
 * raw source, and extraction provenance remain untouched, so a later explicit
 * transition can reactivate the commitment and manual retirement remains
 * auditable.  We fail open when provenance is unavailable because silently
 * hiding an untracked promise is less safe than retaining it.
 */
export function applyCommitmentAgeOut(state, segments = [], { maxSegments = 0 } = {}) {
  const threshold = Math.max(0, Math.floor(Number(maxSegments) || 0));
  const cloned = structuredClone(state ?? {});
  if (!threshold || !cloned.commitments || typeof cloned.commitments !== 'object') return { state: cloned, agedOut: [] };

  const infos = segmentInfo(segments);
  const currentOrdinal = Math.max(0, ...[...infos.values()].map(info => Number(info.segmentOrdinal) || 0));
  if (!currentOrdinal) return { state: cloned, agedOut: [] };
  const provenance = provenanceMap(segments, infos);
  const agedOut = [];
  for (const [id, value] of Object.entries(cloned.commitments)) {
    if (!value || !['active', 'made', 'unknown'].includes(value.status)) continue;
    const origin = provenance.get(`commitment:${id}`);
    if (!origin || !Number.isFinite(origin.segmentOrdinal)) continue;
    const ageSegments = Math.max(0, currentOrdinal - origin.segmentOrdinal);
    if (ageSegments < threshold) continue;
    delete cloned.commitments[id];
    for (const character of Object.values(cloned.characters ?? {})) {
      if (character?.commitments && typeof character.commitments === 'object') delete character.commitments[id];
    }
    agedOut.push({
      id,
      actor: value.actor ?? null,
      toward: value.toward ?? null,
      content: value.content ?? null,
      ageSegments,
      sourceSegmentId: origin.segmentId ?? null,
      sourceMessageRange: Number.isInteger(origin.firstMessage) || Number.isInteger(origin.lastMessage)
        ? { first: origin.firstMessage ?? null, last: origin.lastMessage ?? null }
        : null,
    });
  }
  return { state: cloned, agedOut };
}

function compareItems(left, right) {
  const leftMessage = left.chronology?.lastMessage ?? -1;
  const rightMessage = right.chronology?.lastMessage ?? -1;
  const leftSegment = left.chronology?.segmentOrdinal ?? -1;
  const rightSegment = right.chronology?.segmentOrdinal ?? -1;
  return right.priority - left.priority
    || rightMessage - leftMessage
    || rightSegment - leftSegment
    || left.id.localeCompare(right.id);
}

export function projectNarrativeState(state, { negativeLimit = 6, entityRecords = [], segments = [], commitmentAgeOutSegments = 0 } = {}) {
  const aged = applyCommitmentAgeOut(state, segments, { maxSegments: commitmentAgeOutSegments });
  state = aged.state;
  const items = [];
  const entities = entityLookup(entityRecords);
  const infos = segmentInfo(segments);
  const provenance = provenanceMap(segments, infos);
  for (const [id, value] of Object.entries(state?.commitments ?? {})) if (['active', 'made', 'unknown'].includes(value.status)) add(items, id, 'commitment', renderCommitment(value, entities), 140, chronologyFor(provenance, 'commitment', id));
  for (const [id, value] of Object.entries(state?.relationships ?? {})) add(items, id, 'relationship', renderRelationship(value, id, entities), 130, chronologyFor(provenance, 'relationship', id));
  for (const [id, value] of Object.entries(state?.characters ?? {})) add(items, id, 'character', renderCharacter(value, id, entities), 120, chronologyFor(provenance, 'character', id));
  for (const [id, value] of Object.entries(state?.threads ?? {})) if (!['resolved', 'abandoned'].includes(value.status)) add(items, id, 'thread', `Open thread (${value.status ?? 'active'}): ${value.description ?? value.key ?? id}`, 110, chronologyFor(provenance, 'thread', id));
  for (const [id, value] of Object.entries(state?.worldFacts ?? {})) add(items, id, 'world_fact', renderFact('World fact', value, id, entities), 100, chronologyFor(provenance, 'world_fact', id));
  for (const [id, value] of Object.entries(state?.narratorFacts ?? {})) add(items, id, 'narrator_fact', renderFact('Narrator-only fact', value, id, entities), 90, chronologyFor(provenance, 'narrator_fact', id));
  const negatives = [...(state?.salientNegatives ?? [])].slice(-Math.max(0, negativeLimit));
  negatives.forEach((value, index) => {
    const id = value.key ?? index;
    const chronology = infos.get(value.segmentId) ?? chronologyFor(provenance, 'salient_negative', normalizedNegativeKey(value.proposition));
    add(items, id, 'salient_negative', `Did not happen: ${value.proposition}${value.reason ? ` — ${value.reason}` : ''}`, 70, chronology);
  });
  return items.sort(compareItems);
}

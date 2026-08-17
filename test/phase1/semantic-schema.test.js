import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EvidenceLevel, MemorySegmentStatus, ModelEvidenceLevel, PersistenceClass,
  RelationshipDimension, Salience,
} from '../../src/domain/enums.js';
import { createMessageSourceRef, createSourceRange } from '../../src/domain/fingerprint.js';
import { assertEntityId, entityIdFromSeed, segmentIdFromSource } from '../../src/domain/ids.js';
import {
  deserializePortable, emptyEpisodeSummary, EPISODE_EXTRACTION_JSON_SCHEMA,
  SchemaValidationError, SCHEMA_VERSION, serializePortable, validateConflict,
  validateEpisodeSummary, validateMemorySegment, validateRegisterEnvelope,
} from '../../src/domain/schema.js';
import { normalizeExtractedSummary } from '../../src/extraction/semantic-normalizer.js';

const peter = entityIdFromSeed('fixture:peter');
const mj = entityIdFromSeed('fixture:mj');

function validEpisode() {
  const episode = emptyEpisodeSummary('Peter tells MJ the truth and repeats his promise.');
  episode.entities.push({ mention: 'Peter', proposedEntityId: peter, aliases: ['Pete'] });
  episode.events.push({
    description: 'Peter tells MJ about the meeting.', participants: [peter, mj], evidence: 'explicit',
    salience: 'important', domains: ['relationship'],
  });
  episode.observations.push({
    subject: peter, predicate: 'honesty', value: true, description: 'Peter discloses the meeting.',
    evidence: 'explicit', persistence: 'historical', salience: 'important', domains: ['relationship'],
  });
  episode.stateChanges.push({ subject: peter, path: 'currentCondition.ribs', operation: 'set', value: 'injured', evidence: 'explicit', persistence: 'active' });
  episode.knowledgeChanges.push({ holder: mj, proposition: 'Peter met Felicia', kind: 'knows', operation: 'add', evidence: 'explicit' });
  episode.relationshipChanges.push({ participants: [peter, mj], dimension: 'trust', operation: 'set', value: 'repairing', evidence: 'explicit' });
  episode.commitments.push({ actor: peter, toward: mj, content: 'Do not hide relevant information', transition: 'made', evidence: 'explicit' });
  episode.threads.push({ key: 'felicia_honesty', description: 'Honesty after the Felicia meeting', transition: 'resolved', evidence: 'explicit' });
  episode.salientNegatives.push({ proposition: 'Peter and Felicia kissed', reason: 'Peter explicitly stopped the attempt', evidence: 'explicit' });
  episode.registerObservations.push({ kind: 'event_result', registerKey: 'wrc_2006', eventKey: 'acropolis', entries: [{ subject: peter, position: 1 }], evidence: 'explicit' });
  episode.interpretations.push({ description: 'MJ may remain wary.', evidence: 'weak_inference' });
  episode.temporal.push({ description: 'The next morning', kind: 'relative', evidence: 'explicit' });
  episode.locations.push({ subject: peter, location: "Peter's apartment", kind: 'scene', evidence: 'explicit' });
  return episode;
}

test('Phase 1: EntityId is deterministic, stable, and validated', () => {
  assert.equal(entityIdFromSeed('fixture:peter'), peter);
  assert.match(assertEntityId(peter), /^ent_[0-9a-f]{16}$/);
  assert.notEqual(entityIdFromSeed('fixture:peter'), entityIdFromSeed('fixture:mj'));
  assert.throws(() => assertEntityId('Peter'), /Invalid EntityId/);
});

test('Phase 1: source refs include active swipe identity', () => {
  const ref = createMessageSourceRef({ role: 'assistant', name: 'Peter', text: 'Hello', swipeId: 2 }, 8);
  assert.deepEqual({ index: ref.messageIndex, swipe: ref.activeSwipe }, { index: 8, swipe: 2 });
  assert.match(ref.messageFingerprint, /^fp1_/);
});

test('Phase 1: range fingerprint is deterministic', () => {
  const messages = [{ role: 'user', text: 'A', swipeId: 0 }, { role: 'assistant', text: 'B', swipeId: 1 }];
  assert.equal(createSourceRange(messages, 4).rangeFingerprint, createSourceRange(structuredClone(messages), 4).rangeFingerprint);
});

test('Phase 1: fingerprint changes on message edit', () => {
  const before = createSourceRange([{ role: 'user', text: 'A', swipeId: 0 }]);
  const after = createSourceRange([{ role: 'user', text: 'Edited', swipeId: 0 }]);
  assert.notEqual(before.rangeFingerprint, after.rangeFingerprint);
});

test('Phase 1: fingerprint changes on active swipe', () => {
  const before = createSourceRange([{ role: 'assistant', text: 'Same text', swipeId: 0 }]);
  const after = createSourceRange([{ role: 'assistant', text: 'Same text', swipeId: 1 }]);
  assert.notEqual(before.rangeFingerprint, after.rangeFingerprint);
});

test('Phase 1: status/evidence/persistence/salience algebras reject invalid values', () => {
  assert.equal(MemorySegmentStatus.assert('valid'), 'valid');
  assert.equal(EvidenceLevel.assert('manual'), 'manual');
  assert.equal(ModelEvidenceLevel.has('manual'), false);
  assert.equal(PersistenceClass.assert('pinned'), 'pinned');
  assert.equal(Salience.assert('critical'), 'critical');
  assert.throws(() => MemorySegmentStatus.assert('ready'), /must be one of/);
});

test('Phase 1: complete episode schema validates all semantic record families', () => {
  const result = validateEpisodeSummary(validEpisode());
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.value.knowledgeChanges[0].kind, 'knows');
});

test('Phase 1: missing arrays, invalid epistemics, and weak negatives are rejected', () => {
  const missing = { synopsis: 'Only prose' };
  assert.equal(validateEpisodeSummary(missing).ok, false);
  const episode = validEpisode();
  episode.knowledgeChanges[0].kind = 'psychic';
  episode.salientNegatives[0].evidence = 'weak_inference';
  const result = validateEpisodeSummary(episode);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /psychic/);
  assert.match(result.errors.join(' '), /cannot be weak/);
});

test('Phase 1: provider-specific omitted empty extraction families normalize to empty arrays', () => {
  const normalized = normalizeExtractedSummary({ synopsis: 'A compact provider response.' }, { allowOmittedEmptyFamilies: true });
  assert.equal(normalized.synopsis, 'A compact provider response.');
  for (const field of ['entities', 'events', 'observations', 'stateChanges', 'knowledgeChanges', 'relationshipChanges', 'commitments', 'threads', 'salientNegatives', 'registerObservations', 'interpretations', 'temporal', 'locations']) {
    assert.deepEqual(normalized[field], [], field);
  }
  assert.equal(validateEpisodeSummary(normalized).ok, true);
});

test('Phase 1: relationship dimensions keep formal, romantic, sexual, and intent fields distinct', () => {
  for (const dimension of ['formal_status', 'romantic_attraction', 'romantic_intent', 'sexual_attraction', 'sexual_intent', 'sexual_history', 'exclusivity']) {
    assert.equal(RelationshipDimension.has(dimension), true);
  }
  const episode = validEpisode();
  episode.relationshipChanges = [
    { participants: [peter, mj], dimension: 'formal_status', operation: 'set', value: 'exes', evidence: 'explicit' },
    { participants: [peter, mj], dimension: 'sexual_history', operation: 'add', value: 'prior encounter', evidence: 'explicit' },
    { participants: [peter, mj], dimension: 'romantic_attraction', operation: 'set', value: 'unknown', evidence: 'explicit' },
  ];
  const result = validateEpisodeSummary(episode);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.value.relationshipChanges.map(change => change.dimension), ['formal_status', 'sexual_history', 'romantic_attraction']);
});

test('Phase 1: valid MemorySegment requires schema/prompt versions and valid summary', () => {
  const source = createSourceRange([{ role: 'user', text: 'A', swipeId: 0 }]);
  const segment = {
    id: segmentIdFromSource(source.rangeFingerprint), source, dependencyIds: [], sourceTokenCount: 1,
    summary: validEpisode(), status: 'valid', createdAt: 1, updatedAt: 1,
    schemaVersion: SCHEMA_VERSION, promptVersion: 1, manuallyEdited: false, pinned: false,
  };
  assert.equal(validateMemorySegment(segment).ok, true);
  segment.schemaVersion = 0;
  assert.equal(validateMemorySegment(segment).ok, false);
});

test('Phase 1: invalid MemorySegment variants are rejected', () => {
  const result = validateMemorySegment({ status: 'ready', dependencyIds: 'none' });
  assert.equal(result.ok, false);
  assert.throws(() => validateMemorySegment({ status: 'ready' }, { throwOnError: true }), SchemaValidationError);
});

test('Phase 1: register envelope supports lifecycle and schema version', () => {
  const value = { key: 'wrc_2006', type: 'championship', lifecycle: 'active', observations: [], schemaVersion: 1 };
  assert.equal(validateRegisterEnvelope(value).ok, true);
  assert.equal(validateRegisterEnvelope({ ...value, lifecycle: 'forgotten' }).ok, false);
});

test('Phase 1: unresolved conflicts require two source-grounded candidates', () => {
  const conflict = {
    id: 'conflict-alice-father-age', subject: peter, property: 'father.death_age', status: 'unresolved',
    candidates: [
      { sourceFingerprint: 'fp1_a', description: 'age 10' },
      { sourceFingerprint: 'fp1_b', description: 'age 14' },
    ],
  };
  assert.equal(validateConflict(conflict).ok, true);
  assert.equal(validateConflict({ ...conflict, candidates: conflict.candidates.slice(0, 1) }).ok, false);
});

test('Phase 1: sparse serialization removes undefined without inventing defaults', () => {
  const episode = validEpisode();
  episode.entities[0].canonicalNameCandidate = undefined;
  const roundtrip = deserializePortable(serializePortable(episode), validateEpisodeSummary);
  assert.equal(Object.hasOwn(roundtrip.entities[0], 'canonicalNameCandidate'), false);
  assert.equal(roundtrip.relationshipChanges[0].dimension, 'trust');
});

test('Phase 1: JSON Schema is versioned and requires every extraction array', () => {
  assert.equal(EPISODE_EXTRACTION_JSON_SCHEMA['x-mnemosyne-schema-version'], SCHEMA_VERSION);
  assert.equal(EPISODE_EXTRACTION_JSON_SCHEMA.additionalProperties, false);
  assert.ok(EPISODE_EXTRACTION_JSON_SCHEMA.required.includes('knowledgeChanges'));
  assert.ok(EPISODE_EXTRACTION_JSON_SCHEMA.required.includes('registerObservations'));
});

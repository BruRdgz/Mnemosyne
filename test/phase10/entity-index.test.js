import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { entityIdFromSeed } from '../../src/domain/ids.js';
import { EntityRegistry } from '../../src/entities/entity-registry.js';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';
import { LexicalIndex } from '../../src/retrieval/lexical-index.js';
import { materializeEntities, materializeRegisters } from '../../src/storage/materialized-memory.js';
import { normalizeExtractedSummary } from '../../src/extraction/semantic-normalizer.js';

function indexedSegment(id, synopsis) {
  const summary = emptyEpisodeSummary(synopsis);
  return { id, status: 'valid', source: { first: { messageIndex: Number(id.slice(1)) }, last: { messageIndex: Number(id.slice(1)) } }, summary };
}

test('Phase 10: canonical entity records use stable IDs and provenance', () => {
  const registry = new EntityRegistry();
  const peter = registry.create({ canonicalName: 'Peter Parker', contextKey: 'main', provenance: ['S1'] });
  assert.match(peter.id, /^ent_/);
  assert.deepEqual(peter.provenance, ['S1']);
  assert.equal(registry.list()[0].canonicalName, 'Peter Parker');
});

test('Phase 10: Peter/Pete/Peter Parker alias can be proposed then explicitly confirmed', () => {
  const registry = new EntityRegistry();
  const peter = registry.create({ canonicalName: 'Peter Parker', contextKey: 'main' });
  const proposal = registry.propose('Peter', { contextKey: 'main' });
  assert.equal(proposal.proposedEntityId, peter.id);
  assert.equal(proposal.requiresConfirmation, true);
  assert.throws(() => registry.addAlias(peter.id, 'Pete'), /confirmation/);
  registry.addAlias(peter.id, 'Pete', { confirmed: true, provenance: ['S2'] });
  assert.equal(registry.propose('Pete').proposedEntityId, peter.id);
});

test('Phase 10: same-name characters in different contexts remain unresolved', () => {
  const registry = new EntityRegistry();
  registry.create({ canonicalName: 'Alex', contextKey: 'group-a' });
  registry.create({ canonicalName: 'Alex', contextKey: 'group-b' });
  const proposal = registry.propose('Alex');
  assert.equal(proposal.proposedEntityId, null);
  assert.equal(proposal.requiresConfirmation, true);
  assert.equal(proposal.candidates.length, 2);
});

test('Phase 10: risky partial-name merge remains uncertain', () => {
  const registry = new EntityRegistry();
  registry.create({ canonicalName: 'Mary Jane Watson', contextKey: 'main' });
  const proposal = registry.propose('Mary');
  assert.equal(proposal.confidence, 'uncertain');
  assert.equal(proposal.proposedEntityId, null);
});

test('Phase 10: hydrated records preserve IDs and confirmed aliases', () => {
  const id = entityIdFromSeed('chat:fixture:mention:peter parker');
  const registry = EntityRegistry.fromRecords([{
    id,
    canonicalName: 'Peter Parker',
    aliases: [{ value: 'Pete', confirmed: true, provenance: ['manual'] }],
    kind: 'character',
    contextKey: 'fixture',
    provenance: [],
  }], { contextKey: 'fixture' });
  assert.equal(registry.propose('Pete', { contextKey: 'fixture' }).proposedEntityId, id);
  assert.equal(registry.get(id).aliases[0].confirmed, true);
  assert.equal(registry.list()[0].id, id);
});

test('Phase 10: live normalization reuses exact hydrated aliases but refuses fuzzy merges', () => {
  const id = entityIdFromSeed('chat:fixture:mention:peter parker');
  const known = [{ id, canonicalName: 'Peter Parker', aliases: [{ value: 'Pete', confirmed: false }], contextKey: 'fixture', provenance: [] }];
  const exact = emptyEpisodeSummary('Pete arrives.');
  exact.entities.push({ mention: 'Pete' });
  exact.events.push({ description: 'Pete arrives.', participants: ['Pete'], evidence: 'explicit', salience: 'normal', domains: ['general'] });
  const linked = normalizeExtractedSummary(exact, { contextKey: 'fixture', knownEntities: known });
  assert.equal(linked.entities[0].proposedEntityId, id);
  assert.deepEqual(linked.events[0].participants, [id]);

  const partial = emptyEpisodeSummary('Peter arrives.');
  partial.entities.push({ mention: 'Peter' });
  partial.events.push({ description: 'Peter arrives.', participants: ['Peter'], evidence: 'explicit', salience: 'normal', domains: ['general'] });
  const unresolved = normalizeExtractedSummary(partial, { contextKey: 'fixture', knownEntities: known });
  const partialId = entityIdFromSeed('chat:fixture:mention:peter');
  assert.equal(unresolved.entities[0].proposedEntityId, partialId);
  assert.notEqual(unresolved.entities[0].proposedEntityId, id);
  assert.deepEqual(unresolved.events[0].participants, [partialId]);
});

test('Phase 10: lexical index searches synopsis and dedicated thread/commitment/register fields', () => {
  const s1 = indexedSegment('S1', 'Peter hides a phone message from MJ.');
  s1.summary.threads.push({ key: 'felicia_honesty', description: 'Honesty after Felicia', transition: 'open', evidence: 'explicit' });
  s1.summary.commitments.push({ id: 'honesty_promise', actor: 'x', content: 'No lies by omission', transition: 'made', evidence: 'explicit' });
  s1.summary.registerObservations.push({ kind: 'generic', registerKey: 'wrc', observationKey: 'leader', evidence: 'explicit' });
  const index = new LexicalIndex();
  index.rebuild([s1, indexedSegment('S2', 'Unrelated dinner scene.')]);
  assert.equal(index.search('phone concealment')[0].id, 'S1');
  assert.deepEqual(index.byThread('felicia_honesty'), ['S1']);
  assert.deepEqual(index.byCommitment('honesty_promise'), ['S1']);
  assert.deepEqual(index.byRegister('wrc'), ['S1']);
});

test('Phase 10: obsolete commitments do not remain lexical retrieval targets', () => {
  const index = new LexicalIndex();
  const active = indexedSegment('active', 'Active promise');
  active.summary.commitments.push({ id: 'promise', actor: 'x', content: 'Return the key', transition: 'active', evidence: 'explicit' });
  const obsolete = indexedSegment('obsolete', 'Obsolete promise');
  obsolete.summary.commitments.push({ id: 'old-promise', actor: 'x', content: 'Return the old key', transition: 'obsolete', evidence: 'explicit' });
  index.rebuild([active, obsolete]);
  assert.deepEqual(index.byCommitment('promise'), ['active']);
  assert.deepEqual(index.byCommitment('old-promise'), []);
});

test('Phase 10: index serializes, hydrates, and rebuilds from valid semantic records only', () => {
  const index = new LexicalIndex();
  index.rebuild([indexedSegment('S1', 'phone promise'), { ...indexedSegment('S2', 'stale secret'), status: 'stale' }]);
  const serialized = index.serialize();
  const hydrated = new LexicalIndex();
  hydrated.hydrate(serialized);
  assert.equal(hydrated.size, 1);
  assert.equal(hydrated.search('phone')[0].id, 'S1');
});

test('Phase 10: index rebuild metrics report count, bytes, and latency', () => {
  let tick = 0;
  const metrics = new MetricsRecorder({ now: () => ++tick });
  const index = new LexicalIndex({ metrics });
  const result = index.rebuild([indexedSegment('S1', 'one'), indexedSegment('S2', 'two')]);
  assert.equal(result.documentCount, 2);
  assert.ok(result.serializedBytes > 0);
  const metric = metrics.snapshot()[0];
  assert.equal(metric.operation, 'lexical_index_rebuild');
  assert.ok(metric.durationMs > 0);
});

test('Phase 10: valid segment mentions and registers materialize into the portable envelope views', () => {
  const edward = entityIdFromSeed('chat:fixture:mention:edward');
  const first = indexedSegment('S1', 'Edward returns.');
  first.source.rangeFingerprint = 'fp-one';
  first.summary.entities.push({ mention: 'Edward', proposedEntityId: edward });
  first.summary.registerObservations.push({ kind: 'generic', registerKey: 'mission_obligations', observationKey: 'notice', value: 'required', evidence: 'explicit' });
  const second = indexedSegment('S2', 'Edward gives notice.');
  second.source.rangeFingerprint = 'fp-two';
  second.summary.entities.push({ mention: 'Edward Étienne-Beaumont', proposedEntityId: edward, aliases: ['Edward'] });
  const entities = materializeEntities([first, second], { contextKey: 'fixture' });
  const registers = materializeRegisters([first, second]);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].provenance.length, 2);
  assert.ok(entities[0].aliases.some(alias => alias.value === 'Edward Étienne-Beaumont'));
  assert.equal(registers.length, 1);
  assert.equal(registers[0].observations[0].observationKey, 'notice');
});

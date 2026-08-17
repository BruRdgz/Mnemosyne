import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { SemanticStore } from '../../src/storage/semantic-store.js';

function memoryAdapter(initial = null) {
  let value = structuredClone(initial);
  let saves = 0;
  return {
    readPortableMemory: async () => structuredClone(value),
    writePortableMemory: async next => { value = structuredClone(next); saves += 1; },
    state: () => structuredClone(value),
    saves: () => saves,
  };
}

function segment(firstIndex = 0, synopsis = 'Episode synopsis') {
  const messages = [{ index: firstIndex, role: 'user', text: `source-${firstIndex}`, tokenCount: 2, swipeId: 0 }];
  const source = createSourceRange(messages, firstIndex);
  return {
    id: segmentIdFromSource(source.rangeFingerprint), source, dependencyIds: [], sourceTokenCount: 2,
    summary: emptyEpisodeSummary(synopsis), status: 'valid', createdAt: 1, updatedAt: 1,
    schemaVersion: 1, promptVersion: 1, manuallyEdited: false, pinned: false,
  };
}

test('Phase 6: episodic synopsis/provenance/dependencies survive reload', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const value = segment(0);
  value.dependencyIds = ['seg_prior'];
  await store.commitSegment(value);
  const reloaded = new SemanticStore({ adapter, chatId: 'chat-a' });
  await reloaded.load();
  assert.equal(reloaded.get(value.id).summary.synopsis, 'Episode synopsis');
  assert.equal(reloaded.get(value.id).source.rangeFingerprint, value.source.rangeFingerprint);
  assert.deepEqual(reloaded.get(value.id).dependencyIds, ['seg_prior']);
});

test('Phase 6: duplicate identical commit is idempotent', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const value = segment(0);
  assert.equal(await store.commitSegment(value), true);
  assert.equal(await store.commitSegment(value), false);
  assert.equal(store.timeline().length, 1);
});

test('Phase 6: manual edit has provenance and outranks generated replacement', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const value = segment(0);
  await store.commitSegment(value);
  const edited = await store.editSynopsis(value.id, 'User-corrected synopsis');
  assert.equal(edited.manuallyEdited, true);
  assert.equal(edited.manualProvenance.kind, 'manual');
  const generated = { ...value, summary: emptyEpisodeSummary('Model replacement'), updatedAt: 99 };
  assert.equal(await store.commitSegment(generated), false);
  assert.equal(store.get(value.id).summary.synopsis, 'User-corrected synopsis');
});

test('Phase 6: retiring an active commitment preserves source and records manual provenance', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const value = segment(2, 'A promise is no longer relevant.');
  value.summary.commitments.push({ id: 'old_promise', actor: 'ent_0000000000000001', toward: 'ent_0000000000000002', content: 'Bring the notes tomorrow', transition: 'active', evidence: 'explicit' });
  await store.commitSegment(value);
  const sourceBefore = structuredClone(store.get(value.id).source);
  const retired = await store.retireCommitment(value.id, 'old_promise');
  assert.equal(retired.summary.commitments[0].transition, 'obsolete');
  assert.equal(retired.manuallyEdited, true);
  assert.equal(retired.manualProvenance.lastAction, 'retire_commitment');
  assert.equal(retired.manualProvenance.commitmentRetirements[0].previousTransition, 'active');
  assert.deepEqual(retired.source, sourceBefore);
  assert.equal(adapter.state().segments[0].summary.commitments[0].transition, 'obsolete');
  const reloaded = new SemanticStore({ adapter, chatId: 'chat-a' });
  await reloaded.load();
  assert.equal(reloaded.get(value.id).summary.commitments[0].transition, 'obsolete');
});

test('Phase 6: retiring an already closed commitment is idempotent and invalid indexes fail', async () => {
  const store = new SemanticStore({ adapter: memoryAdapter(), chatId: 'chat-a' });
  const value = segment(3);
  value.summary.commitments.push({ actor: 'ent_0000000000000001', content: 'Already kept', transition: 'kept', evidence: 'explicit' });
  await store.commitSegment(value);
  const before = store.snapshot();
  const result = await store.retireCommitment(value.id, 0);
  assert.deepEqual(result, store.get(value.id));
  assert.deepEqual(store.snapshot(), before);
  await assert.rejects(() => store.retireCommitment(value.id, 9), /Unknown commitment/);
});

test('Phase 6: pin and exclusion policy persist and exclusion filters timeline', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const value = segment(0);
  await store.commitSegment(value);
  await store.setPinned(value.id, true);
  await store.setExcluded(value.id, true);
  assert.equal(store.get(value.id).pinned, true);
  assert.equal(store.get(value.id).status, 'excluded');
  assert.equal(store.timeline({ includeExcluded: false }).length, 0);
  const reloaded = new SemanticStore({ adapter, chatId: 'chat-a' });
  await reloaded.load();
  assert.equal(reloaded.get(value.id).pinned, true);
  assert.equal(reloaded.get(value.id).status, 'excluded');
});

test('Phase 6: regenerate preserves exact source identity while clearing derived memory', async () => {
  const store = new SemanticStore({ adapter: memoryAdapter(), chatId: 'chat-a' });
  const value = segment(4);
  await store.commitSegment(value);
  const pending = await store.prepareRegeneration(value.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.summary, null);
  assert.deepEqual(pending.source, value.source);
  assert.equal(pending.id, value.id);
});

test('Phase 6: source inspection returns only the linked active range', async () => {
  const store = new SemanticStore({ adapter: memoryAdapter(), chatId: 'chat-a' });
  const value = segment(1);
  await store.commitSegment(value);
  const active = [{ text: 'zero' }, { text: 'one' }, { text: 'two' }];
  assert.deepEqual(store.sourceFor(value.id, active), [{ text: 'one' }]);
});

test('Phase 6: cross-chat portable memory is rejected', async () => {
  const adapter = memoryAdapter();
  const first = new SemanticStore({ adapter, chatId: 'chat-a' });
  await first.commitSegment(segment(0));
  const second = new SemanticStore({ adapter, chatId: 'chat-b' });
  await assert.rejects(() => second.load(), /different chat/);
});

test('Phase 6: durable metadata failure rolls back in-memory mutations', async () => {
  let persisted = null;
  let failWrites = false;
  const adapter = {
    readPortableMemory: async () => structuredClone(persisted),
    writePortableMemory: async next => {
      if (failWrites) throw new Error('metadata write failed');
      persisted = structuredClone(next);
    },
  };
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const value = segment(0);
  await store.commitSegment(value);
  const before = store.snapshot();
  failWrites = true;
  await assert.rejects(() => store.commitSegment({ ...value, summary: emptyEpisodeSummary('Unpersisted replacement') }), /metadata write failed/);
  await assert.rejects(() => store.setPinned(value.id, true), /metadata write failed/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(persisted.segments[0].summary.synopsis, 'Episode synopsis');
  assert.equal(persisted.segments[0].pinned, false);
});

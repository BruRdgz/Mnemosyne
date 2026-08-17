import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { createPortableEnvelope } from '../../src/storage/semantic-store.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

function historicalChat(count = 14) {
  return Array.from({ length: count }, (_, index) => ({ is_user: index % 2 === 0, is_system: false, name: index % 2 ? 'Character' : 'User', mes: `m${index}`, swipe_id: 0 }));
}

function existingSegment(messages, first, last, synopsis = 'Existing memory.') {
  const source = createSourceRange(messages.slice(first, last + 1), first);
  return { id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: first, lastIndex: last, dependencyIds: [], sourceTokenCount: last - first + 1, summary: emptyEpisodeSummary(synopsis), status: 'valid', createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 1, manuallyEdited: true, pinned: false };
}

function backfillRuntime({ generateRaw } = {}) {
  const messages = historicalChat();
  const fake = createFakeContext({
    chat: messages,
    chatMetadata: { mnemosyne: createPortableEnvelope('fixture-chat') },
    generateRaw,
  });
  return { messages, fake, runtime: bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 4, contextBudget: 100, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, preemptiveRatio: 0.8 } },
    localforage: createMemoryLocalForage(),
  }) };
}

test('Historical backfill: analysis is local, estimates calls, and writes nothing', async () => {
  let modelCalls = 0;
  const fixture = backfillRuntime({ generateRaw: async () => { modelCalls += 1; return '{}'; } });
  const runtime = await fixture.runtime;
  const before = structuredClone(fixture.fake.context.chatMetadata.mnemosyne);
  const analysis = await runtime.narrative.analyzeBackfill();
  assert.equal(modelCalls, 0);
  assert.equal(analysis.messageCount, 14);
  assert.equal(analysis.rawForegroundMessageCount, 4);
  assert.equal(analysis.uncoveredMessageCount, 10);
  assert.equal(analysis.plannedSegmentCount, 5);
  assert.deepEqual(fixture.fake.context.chatMetadata.mnemosyne, before);
  runtime.dispose();
});

test('Historical backfill: fills every old segment, reports outputs, and preserves raw chat', async () => {
  let modelCalls = 0;
  const fixture = backfillRuntime({ generateRaw: async () => { modelCalls += 1; return JSON.stringify(emptyEpisodeSummary(`Backfilled episode ${modelCalls}.`)); } });
  const sourceBefore = structuredClone(fixture.messages);
  const runtime = await fixture.runtime;
  const state = await runtime.narrative.runBackfill();
  assert.equal(state.status, 'complete');
  assert.equal(state.report.processed, 5);
  assert.equal(state.report.valid, 5);
  assert.equal(state.report.failed, 0);
  assert.equal(state.report.outputs.length, 5);
  assert.equal(state.report.outputs[0].summary.synopsis, 'Backfilled episode 1.');
  assert.equal(state.analysis.plannedSegmentCount, 0);
  assert.equal(modelCalls, 5);
  assert.deepEqual(fixture.messages, sourceBefore);
  runtime.dispose();
});

test('Historical backfill: pause and resume happen between segments', async () => {
  let modelCalls = 0;
  const fixture = backfillRuntime({ generateRaw: async () => { modelCalls += 1; return JSON.stringify(emptyEpisodeSummary(`Episode ${modelCalls}.`)); } });
  const runtime = await fixture.runtime;
  const paused = await runtime.narrative.runBackfill({ onProgress: () => runtime.narrative.pauseBackfill() });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.report.processed, 1);
  const completed = await runtime.narrative.runBackfill();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.report.processed, 5);
  assert.equal(modelCalls, 5);
  runtime.dispose();
});

test('Historical backfill: async progress persistence completes before the next segment', async () => {
  let modelCalls = 0;
  let persistedThrough = 0;
  const fixture = backfillRuntime({ generateRaw: async () => {
    modelCalls += 1;
    assert.equal(persistedThrough, modelCalls - 1);
    return JSON.stringify(emptyEpisodeSummary(`Episode ${modelCalls}.`));
  } });
  const runtime = await fixture.runtime;
  const state = await runtime.narrative.runBackfill({ onProgress: async status => {
    await Promise.resolve();
    persistedThrough = status.report.processed;
  } });
  assert.equal(state.status, 'complete');
  assert.equal(persistedThrough, 5);
  runtime.dispose();
});

test('Historical backfill: provider failure stops safely and retains inspectable failed output', async () => {
  const fixture = backfillRuntime({ generateRaw: async () => { throw new Error('offline'); } });
  const sourceBefore = structuredClone(fixture.messages);
  const runtime = await fixture.runtime;
  const state = await runtime.narrative.runBackfill();
  assert.equal(state.status, 'stopped-on-failure');
  assert.equal(state.report.processed, 1);
  assert.equal(state.report.failed, 1);
  assert.equal(state.report.outputs[0].status, 'failed');
  assert.equal(state.report.outputs[0].summary, null);
  assert.deepEqual(fixture.messages, sourceBefore);
  runtime.dispose();
});

test('Historical backfill: schema and quota failures block the suffix and resume the failed range', async () => {
  let schemaCalls = 0;
  const schemaFixture = backfillRuntime({ generateRaw: async () => {
    schemaCalls += 1;
    return schemaCalls === 1 ? '{}' : JSON.stringify(emptyEpisodeSummary(`Recovered episode ${schemaCalls}.`));
  } });
  const schemaRuntime = await schemaFixture.runtime;
  const collected = await schemaRuntime.narrative.runBackfill();
  assert.equal(collected.status, 'stopped-on-failure');
  assert.equal(collected.report.processed, 1);
  assert.equal(collected.report.failed, 1);
  assert.equal(collected.report.valid, 0);
  const resumed = await schemaRuntime.narrative.runBackfill();
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.report.processed, 6);
  assert.equal(resumed.report.failed, 1);
  assert.equal(resumed.report.valid, 5);
  assert.equal(schemaCalls, 6);
  schemaRuntime.dispose();

  let quotaCalls = 0;
  const quotaFixture = backfillRuntime({ generateRaw: async () => {
    quotaCalls += 1;
    throw Object.assign(new Error('Payment Required'), { code: 'quota' });
  } });
  const quotaRuntime = await quotaFixture.runtime;
  const stopped = await quotaRuntime.narrative.runBackfill();
  assert.equal(stopped.status, 'stopped-on-failure');
  assert.equal(stopped.report.processed, 1);
  assert.equal(stopped.report.outputs[0].extraction.failure, 'provider_quota');
  assert.equal(quotaCalls, 1);
  quotaRuntime.dispose();
});

test('Historical backfill: future preserved memory never contaminates earlier extraction dependencies', async () => {
  const messages = historicalChat();
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [existingSegment(messages, 4, 5, 'Later manual correction.')];
  const fake = createFakeContext({ chat: messages, chatMetadata: { mnemosyne: envelope }, generateRaw: async () => JSON.stringify(emptyEpisodeSummary('Backfilled.')) });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4 } },
    localforage: createMemoryLocalForage(),
  });
  const analysis = await runtime.narrative.analyzeBackfill();
  assert.equal(analysis.plannedSegmentCount, 5);
  await runtime.narrative.runBackfill();
  const first = runtime.narrative.snapshot().segments.find(segment => segment.source.first.messageIndex === 0);
  assert.deepEqual(first.dependencyIds, []);
  assert.equal(runtime.narrative.snapshot().segments.find(segment => segment.source.first.messageIndex === 4).summary.synopsis, 'Later manual correction.');
  runtime.dispose();
});

test('Historical backfill: exact-name semantics materialize entities and registers', async () => {
  const summary = emptyEpisodeSummary('Edward promises Clément to give notice before future missions.');
  summary.entities.push({ mention: 'Edward' }, { mention: 'Clément' });
  summary.relationshipChanges.push({ participants: ['Edward', 'Clément'], dimension: 'trust', operation: 'set', value: 'repairing', evidence: 'explicit' });
  summary.commitments.push({ id: 'departure_notice', actor: 'Edward', toward: 'Clément', content: 'Give notice before future missions.', transition: 'made', evidence: 'explicit' });
  summary.registerObservations.push({ kind: 'generic', registerKey: 'mission_obligations', observationKey: 'notice', value: 'required', evidence: 'explicit' });
  const fixture = backfillRuntime({ generateRaw: async () => JSON.stringify(summary) });
  const runtime = await fixture.runtime;

  await runtime.narrative.runBackfill();

  const snapshot = runtime.narrative.snapshot();
  assert.equal(snapshot.entities.length, 2);
  assert.equal(snapshot.registers.length, 1);
  const generated = snapshot.segments.find(segment => !segment.manuallyEdited);
  assert.match(generated.summary.commitments[0].actor, /^ent_/);
  assert.equal(generated.summary.relationshipChanges[0].participants[0], generated.summary.commitments[0].actor);
  assert.equal(snapshot.registers[0].key, 'mission_obligations');
  runtime.dispose();
});

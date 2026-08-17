import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualification } from '../../benchmarks/run.js';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

test('Phase 15: reproducible qualification covers long-history, retrieval, context, replay, mutation, branches, calls, and storage', async () => {
  const report = await runQualification();
  assert.equal(report.configuration.segmentCount, 120);
  assert.equal(report.retrieval.recallAt5, 1);
  assert.equal(report.retrieval.callbackRank, 1);
  assert.equal(report.replay.statesEquivalent, true);
  assert.equal(report.replay.checkpointSegmentsReplayed, 20);
  assert.equal(report.invalidation.eagerExtractionCalls, 0);
  assert.equal(report.invalidation.branchCacheHits, 100);
  assert.equal(report.qualification.boundedContext, true);
  assert.ok(report.contextEfficiency.netTokensAvoided > 0);
  assert.equal(report.calls.callsPerCommittedSegment, 1);
  assert.equal(report.calls.cachedInputTokens, null);
  assert.ok(report.storageBytes.portableSemanticMemory > 0);
  assert.equal(report.retrieval.continuityAccuracy > report.retrieval.recencyOnlyBaselineAccuracy, true);
});

test('Phase 15: provider failure under pressure persists failed memory and leaves raw history untouched', async () => {
  const chat = Array.from({ length: 10 }, (_, index) => ({ is_user: index % 2 === 0, is_system: false, name: index % 2 ? 'Character' : 'User', mes: `m${index}`, swipe_id: 0 }));
  const sourceBefore = structuredClone(chat);
  let calls = 0;
  const fake = createFakeContext({ chat, generateRaw: async () => { calls += 1; throw new Error('fixture provider unavailable'); } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 8, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, preemptiveRatio: 0.8 } }, localforage: createMemoryLocalForage() });
  fake.eventSource.emit('message_received', 9);
  await runtime.narrative.flushBackground();
  assert.equal(calls, 2);
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'failed');
  assert.deepEqual(chat, sourceBefore);
  runtime.dispose();
});

test('Phase 15: ordinary turn below compaction pressure performs zero memory-model calls', async () => {
  let calls = 0;
  const fake = createFakeContext({ generateRaw: async () => { calls += 1; return '{}'; } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 8_000 } }, localforage: createMemoryLocalForage() });
  fake.eventSource.emit('message_received', 1);
  await runtime.narrative.flushBackground();
  assert.equal(calls, 0);
  runtime.dispose();
});

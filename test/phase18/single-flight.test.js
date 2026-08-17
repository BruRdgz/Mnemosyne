import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

test('Phase 18: opening a chat schedules one bounded automatic compaction', async () => {
  const chat = Array.from({ length: 10 }, (_, index) => ({
    is_user: index % 2 === 0,
    name: index % 2 ? 'Jean' : 'Peter',
    mes: `opening turn ${index}`,
    swipe_id: 0,
  }));
  let calls = 0;
  const fake = createFakeContext({
    chat,
    generateRaw: async () => { calls += 1; return JSON.stringify(emptyEpisodeSummary('Opened chat compacted one segment.')); },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, contextBudget: 100, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, memoryCooldownMs: 0 } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.narrative.handleEvent({ kind: 'chatChanged', chatId: 'fixture-chat' });
  for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
  await runtime.narrative.flushBackground();
  assert.equal(calls, 1);
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'valid');
  assert.ok(runtime.metrics.snapshot().some(metric => metric.operation === 'compaction_schedule' && metric.trigger === 'chat_open'));
  runtime.dispose();
});

test('Phase 18: automatic opening compaction stops at a failed range until explicit retry', async () => {
  const chat = Array.from({ length: 10 }, (_, index) => ({
    is_user: index % 2 === 0,
    name: index % 2 ? 'Jean' : 'Peter',
    mes: `failed opening turn ${index}`,
    swipe_id: 0,
  }));
  let calls = 0;
  const fake = createFakeContext({
    chat,
    generateRaw: async () => { calls += 1; throw new Error('quota exhausted'); },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, contextBudget: 100, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, memoryCooldownMs: 0, memoryExtractionRetries: 0 } },
    localforage: createMemoryLocalForage(),
  });
  const failed = await runtime.narrative.scheduleCompaction({ force: true });
  assert.equal(failed.segment.status, 'failed');
  assert.equal(calls, 1);
  await runtime.narrative.refreshMemory();
  await runtime.narrative.scheduleCompactionOnChatOpen();
  assert.equal(calls, 1, 'a failed range must not be retried by opening the chat');
  assert.ok(runtime.metrics.snapshot().some(metric => metric.operation === 'compaction_schedule' && metric.status === 'blocked_on_failure'));
  runtime.dispose();
});

test('Phase 18: explicit rebuild and automatic compaction share one memory request flight', async () => {
  const chat = Array.from({ length: 8 }, (_, index) => ({
    is_user: index % 2 === 0,
    name: index % 2 ? 'Jean' : 'Peter',
    mes: `turn ${index}`,
    swipe_id: 0,
  }));
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fake = createFakeContext({
    chat,
    generateRaw: async () => {
      calls += 1;
      await gate;
      return JSON.stringify(emptyEpisodeSummary(`Single-flight candidate ${calls}.`));
    },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, preemptiveRatio: 0.8, memoryCooldownMs: 0, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  const planned = await runtime.narrative.startRebuild();
  const first = runtime.narrative.resumeRebuild(planned.id);
  for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(runtime.narrative.generationStatus().memoryOperationBusy, true);
  assert.equal(runtime.narrative.generationStatus().memoryOperationKind, 'rebuild');
  await assert.rejects(() => runtime.narrative.resumeRebuild(planned.id), error => error.code === 'memory_operation_busy');
  assert.equal(await runtime.narrative.scheduleCompaction(), null);
  assert.equal(calls, 1, 'automatic compaction must not start a second provider request');
  assert.ok(runtime.metrics.snapshot().some(metric => metric.operation === 'compaction_schedule' && metric.status === 'busy'));
  release();
  const completed = await first;
  assert.equal(completed.status, 'complete');
  assert.equal(calls, planned.plan.length);
  assert.equal(runtime.narrative.generationStatus().memoryOperationBusy, false);
  runtime.dispose();
});

test('Phase 18: compaction metadata failure releases its job guard before a later retry', async () => {
  const chat = Array.from({ length: 8 }, (_, index) => ({
    is_user: index % 2 === 0,
    name: index % 2 ? 'Jean' : 'Peter',
    mes: `turn ${index}`,
    swipe_id: 0,
  }));
  let failWrites = false;
  let calls = 0;
  const fake = createFakeContext({
    chat,
    chatMetadata: { mnemosyne: { envelopeVersion: 2, schemaVersion: 1, chatId: 'fixture-chat', segments: [], entities: [], registers: [], conflicts: [], checkpoints: [], rebuildSessions: [], preferences: {}, updatedAt: 1 } },
    saveMetadata: async () => { if (failWrites) throw new Error('metadata write failed'); },
    generateRaw: async () => { calls += 1; return JSON.stringify(emptyEpisodeSummary(`Retry candidate ${calls}.`)); },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, contextBudget: 100, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, preemptiveRatio: 0.8, memoryCooldownMs: 0, autoCompact: true } },
    localforage: createMemoryLocalForage(),
  });
  failWrites = true;
  fake.eventSource.emit('message_received', 9);
  await assert.rejects(() => runtime.narrative.flushBackground(), /metadata write failed/);
  await Promise.resolve();
  assert.equal(runtime.narrative.generationStatus().memoryOperationBusy, false);
  assert.equal(calls, 0, 'pending-marker failure must occur before provider work');

  failWrites = false;
  fake.eventSource.emit('message_received', 9);
  await runtime.narrative.flushBackground();
  assert.equal(calls, 1);
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'valid');
  assert.ok(runtime.metrics.snapshot().some(metric => metric.operation === 'compaction_persistence' && metric.status === 'failed_before_request'));
  runtime.dispose();
});

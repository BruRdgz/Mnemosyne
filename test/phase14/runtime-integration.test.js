import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { createPortableEnvelope } from '../../src/storage/semantic-store.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

function chat(count = 10) {
  return Array.from({ length: count }, (_, index) => ({ is_user: index % 2 === 0, is_system: false, name: index % 2 === 0 ? 'User' : 'Character', mes: `m${index}`, swipe_id: 0 }));
}

function validSegment(messages, first, last, synopsis) {
  const source = createSourceRange(messages.slice(first, last + 1), first);
  return { id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: first, lastIndex: last, dependencyIds: [], sourceTokenCount: last - first + 1, summary: emptyEpisodeSummary(synopsis), status: 'valid', createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 1, manuallyEdited: false, pinned: false };
}

test('Phase 14: runtime interceptor injects valid memory and marks only generation copies ignored', async () => {
  const messages = chat();
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [validSegment(messages, 0, 1, 'The first exchange established the secret.')];
  const fake = createFakeContext({ chat: messages, chatMetadata: { mnemosyne: envelope } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, contextBudget: 500 } }, localforage: createMemoryLocalForage() });
  const generationChat = structuredClone(messages);
  await runtime.intercept(generationChat, 500, () => {}, 'normal');
  assert.match(fake.prompts.get('mnemosyne_context'), /first exchange established/);
  assert.equal(generationChat[0].extra[Symbol.for('ignore')], true);
  assert.equal(messages[0].extra, undefined);
  assert.equal(runtime.narrative.promptPreview().preview, fake.prompts.get('mnemosyne_context'));
  assert.equal(fake.promptCalls.at(-1).position, 1);
  assert.equal(fake.promptCalls.at(-1).role, 0);
  assert.equal(fake.promptCalls.at(-1).scan, false);
  assert.ok(Number.isInteger(fake.promptCalls.at(-1).depth));
  assert.equal(runtime.narrative.snapshot().segments[0].source.turnBundles.length, 1);
  runtime.dispose();
});

test('Phase 14: received event schedules one batched preemptive extraction and commits it', async () => {
  const messages = chat();
  let modelCalls = 0;
  const fake = createFakeContext({ chat: messages, generateRaw: async () => { modelCalls += 1; return JSON.stringify(emptyEpisodeSummary('Compacted opening exchange.')); } });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 8, contextBudget: 100, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, preemptiveRatio: 0.8 } },
    localforage: createMemoryLocalForage(),
  });
  fake.eventSource.emit('message_received', 9);
  await runtime.narrative.flushBackground();
  assert.equal(modelCalls, 1);
  assert.equal(runtime.narrative.snapshot().segments.length, 1);
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'valid');
  assert.equal(runtime.narrative.snapshot().segments[0].summary.synopsis, 'Compacted opening exchange.');
  runtime.dispose();
});

test('Phase 14: stale fingerprint loaded from metadata is never injected', async () => {
  const messages = chat();
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [validSegment(messages, 0, 1, 'A confession that no longer exists.')];
  messages[0].mes = 'edited source';
  const fake = createFakeContext({ chat: messages, chatMetadata: { mnemosyne: envelope } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, contextBudget: 100 } }, localforage: createMemoryLocalForage() });
  const generationChat = structuredClone(messages);
  await runtime.intercept(generationChat, 100, () => {}, 'normal');
  assert.doesNotMatch(fake.prompts.get('mnemosyne_context'), /confession/);
  assert.equal(generationChat[0].extra, undefined);
  runtime.dispose();
});

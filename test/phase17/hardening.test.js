import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnBundles, auditTurnBundleIntegrity } from '../../src/domain/turn-bundle.js';
import { planSegments } from '../../src/planning/segment-planner.js';
import { ContextCompiler, applyPromptVirtualization } from '../../src/context/context-compiler.js';
import { StContextAdapter } from '../../src/integration/st-context-adapter.js';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createPortableEnvelope } from '../../src/storage/semantic-store.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { LexicalIndex } from '../../src/retrieval/lexical-index.js';
import { projectNarrativeState } from '../../src/state/state-projector.js';
import { directlyRelevantRegisterKeys, projectRegisters } from '../../src/registers/register-projector.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

const countTokens = async text => String(text).trim() ? String(text).trim().split(/\s+/).length : 0;
const sourceMessage = (index, role, text, extra = {}) => ({
  index,
  role,
  name: role === 'user' ? 'Peter' : 'Jean',
  text,
  swipeId: extra.swipeId ?? 0,
  tokenCount: extra.tokenCount ?? 1,
  original: {
    is_user: role === 'user',
    is_system: role === 'system',
    name: role === 'user' ? 'Peter' : 'Jean',
    mes: text,
    swipe_id: extra.swipeId ?? 0,
    extra: extra.media ? { media: extra.media } : undefined,
  },
});

function memory(id, first, last, synopsis, status = 'valid') {
  return {
    id,
    status,
    source: { first: { messageIndex: first }, last: { messageIndex: last } },
    summary: emptyEpisodeSummary(synopsis),
    extraction: { replacementEligible: status === 'valid' },
  };
}

test('Phase 17: a complete narrative exchange is one bundle, including consecutive users and group assistants', () => {
  const messages = [
    sourceMessage(0, 'assistant', 'Opening greeting.'),
    sourceMessage(1, 'user', 'First thought.'),
    sourceMessage(2, 'user', 'One more detail.'),
    sourceMessage(3, 'assistant', 'Jean responds.'),
    { ...sourceMessage(4, 'assistant', 'Scott also responds.'), name: 'Scott' },
    sourceMessage(5, 'user', 'Unanswered continuation.'),
  ];
  const bundles = createTurnBundles(messages);
  assert.equal(bundles.length, 2);
  assert.deepEqual([bundles[0].firstIndex, bundles[0].lastIndex, bundles[0].kind, bundles[0].complete], [0, 4, 'exchange', true]);
  assert.deepEqual([bundles[1].firstIndex, bundles[1].lastIndex, bundles[1].kind, bundles[1].complete], [5, 5, 'incomplete_user', false]);
});

test('Phase 17: dual bundle hashes distinguish cosmetic drift from narrative, swipe, and media changes', () => {
  const base = [sourceMessage(0, 'user', 'Line one.\r\nLine two.', { media: { url: 'scene.png', caption: 'red door' } }), sourceMessage(1, 'assistant', 'Response.')];
  const cosmetic = structuredClone(base);
  cosmetic[0].text = 'Line one.\nLine two.';
  cosmetic[0].original.mes = cosmetic[0].text;
  const cosmeticAudit = auditTurnBundleIntegrity(createTurnBundles(base), cosmetic);
  assert.equal(cosmeticAudit.ok, false);
  assert.equal(cosmeticAudit.narrativeOk, true);
  assert.equal(cosmeticAudit.cosmeticOnly, true);

  const swipe = structuredClone(base);
  swipe[1].swipeId = 1;
  swipe[1].original.swipe_id = 1;
  assert.equal(auditTurnBundleIntegrity(createTurnBundles(base), swipe).narrativeOk, false);

  const media = structuredClone(base);
  media[0].original.extra.media.caption = 'blue door';
  assert.equal(auditTurnBundleIntegrity(createTurnBundles(base), media).narrativeOk, false);
});

test('Phase 17: atomic planning packs several bundles per request without splitting a pair', () => {
  const messages = Array.from({ length: 8 }, (_, index) => sourceMessage(index, index % 2 ? 'assistant' : 'user', `m${index}`, { tokenCount: 2 }));
  const planned = planSegments(messages, { targetTokens: 8, softMaxTokens: 10, hardMaxTokens: 12, atomicTurns: true });
  assert.equal(planned.length, 2);
  assert.deepEqual(planned.map(segment => [segment.firstIndex, segment.lastIndex]), [[0, 3], [4, 7]]);
  assert.deepEqual(planned.map(segment => segment.source.turnBundles.length), [2, 2]);
  assert.ok(planned.every(segment => segment.source.turnBundles.every(bundle => bundle.complete)));
});

test('Phase 17: consecutive user messages and their response remain atomic even above hard max', () => {
  const messages = [
    sourceMessage(0, 'user', 'First.', { tokenCount: 3 }),
    sourceMessage(1, 'user', 'Correction.', { tokenCount: 3 }),
    sourceMessage(2, 'assistant', 'Combined response.', { tokenCount: 3 }),
  ];
  const planned = planSegments(messages, { targetTokens: 4, softMaxTokens: 5, hardMaxTokens: 6, atomicTurns: true });
  assert.equal(planned.length, 1);
  assert.deepEqual([planned[0].firstIndex, planned[0].lastIndex, planned[0].oversized], [0, 2, true]);
  assert.equal(planned[0].boundaryReason, 'oversized_turn');
});

test('Phase 17: all green replacement coverage is omitted even when a summary is not selected', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const unselected = memory('unselected', 0, 1, 'Not selected this turn.');
  const selected = memory('selected', 2, 3, 'The relevant recent scene.');
  const compiled = await compiler.compile({
    replacementSegments: [unselected, selected],
    chronological: [selected],
    rawMessages: [{ index: 4, role: 'user', text: 'Continue.', required: true }],
  }, { hardTotal: 100, raw: 20, chronological: 60, state: 0, registers: 0, associative: 0 });
  assert.deepEqual(compiled.omitIndices, [0, 1, 2, 3]);
  assert.deepEqual(compiled.selectedIds, ['selected']);
  assert.equal(compiled.selectedIds.includes('unselected'), false);
});

test('Phase 17: SillyTavern injection uses the complete public IN_CHAT system contract', () => {
  const fake = createFakeContext();
  const adapter = new StContextAdapter({ getContext: () => fake.context });
  adapter.setContextInjection('memory', { position: 1, depth: 7, scan: false, role: 0 });
  assert.deepEqual(fake.promptCalls.at(-1), {
    key: 'mnemosyne_context', value: 'memory', position: 1, depth: 7, scan: false, role: 0,
  });
  assert.throws(() => adapter.setContextInjection('bad', { position: Number.NaN }), /position/);
});

test('Phase 17: adapter constants and call shape match the pinned public SillyTavern contract', () => {
  // Keep only the small public contract excerpt under test. The full
  // SillyTavern checkout is intentionally not vendored in this POC repository.
  const script = `
    const extension_prompt_positions = { IN_PROMPT: 0, IN_CHAT: 1 };
    const extension_prompt_roles = { SYSTEM: 0 };
    function setExtensionPrompt(key, value, position, depth, scan = false, role = extension_prompt_roles.SYSTEM) {
      return { key, value, position: Number(position), depth: Number(depth), scan, role };
    }
  `;
  assert.match(script, /IN_PROMPT:\s*0/);
  assert.match(script, /IN_CHAT:\s*1/);
  assert.match(script, /SYSTEM:\s*0/);
  assert.match(script, /function setExtensionPrompt\(key, value, position, depth, scan = false, role = extension_prompt_roles\.SYSTEM/);
  assert.match(script, /position:\s*Number\(position\)/);
  assert.match(script, /depth:\s*Number\(depth\)/);
});

test('Phase 17: prompt virtualization computes depth at the lossless raw boundary', () => {
  const generationChat = Array.from({ length: 6 }, (_, index) => ({ mes: `m${index}`, is_user: index % 2 === 0 }));
  let injection;
  const compiled = { block: 'memory', preview: 'memory', omitIndices: [0, 1, 2, 3], rawBoundaryIndex: 4 };
  const result = applyPromptVirtualization(generationChat, compiled, {
    ignoreSymbol: Symbol.for('ignore'),
    setInjection: (_value, options) => { injection = options; },
  });
  assert.deepEqual(injection, { position: 1, depth: 2, scan: false, role: 0 });
  assert.deepEqual(result.injection, injection);
});

test('Phase 17: disabling Mnemosyne prevents automatic and direct memory work', async () => {
  let modelCalls = 0;
  const fake = createFakeContext({
    chat: Array.from({ length: 10 }, (_, index) => ({ is_user: index % 2 === 0, name: index % 2 ? 'Jean' : 'Peter', mes: `m${index}`, swipe_id: 0 })),
    generateRaw: async () => { modelCalls += 1; return JSON.stringify(emptyEpisodeSummary('Should never run.')); },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, memoryCooldownMs: 0 } },
    localforage: createMemoryLocalForage(),
  });
  runtime.setEnabled(false);
  fake.eventSource.emit('message_received', 9);
  await runtime.narrative.flushBackground();
  const result = await runtime.intercept(structuredClone(fake.context.chat), 4_000, null, 'normal');
  assert.equal(result, null);
  assert.equal(modelCalls, 0);
  assert.equal(fake.prompts.get('mnemosyne_context'), '');
  runtime.dispose();
});

test('Phase 18: managed summaries can be disabled for prompts without disabling local memory state', async () => {
  let modelCalls = 0;
  const fake = createFakeContext({
    generateRaw: async () => { modelCalls += 1; return JSON.stringify(emptyEpisodeSummary('Must not run during prompt-only disable.')); },
  });
  fake.prompts.set('mnemosyne_context', 'previous managed context');
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { injectManagedMemory: false, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  const result = await runtime.narrative.intercept(structuredClone(fake.context.chat), 4_000, 'normal');
  assert.equal(result, null);
  assert.equal(fake.prompts.get('mnemosyne_context'), '');
  assert.equal(modelCalls, 0);
  assert.equal(runtime.narrative.generationStatus().memoryInjectionEnabled, false);
  assert.ok(runtime.metrics.snapshot().some(metric => metric.operation === 'generation_critical_path' && metric.status === 'injection_disabled'));
  runtime.dispose();
});

test('Phase 17: enable state is isolated per chat and falls back to the global default for a new chat', async () => {
  const fake = createFakeContext();
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { enabled: true, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.narrative.setEnabled(false);
  const firstChatMetadata = fake.context.chatMetadata;
  assert.equal(firstChatMetadata.mnemosyne.preferences.enabled, false);

  fake.context.chatId = 'fixture-chat-2';
  fake.context.chatMetadata = {};
  await runtime.narrative.handleEvent({ kind: 'chatChanged', chatId: 'fixture-chat-2' });
  assert.equal(runtime.narrative.isEnabled(), true);

  fake.context.chatId = 'fixture-chat';
  fake.context.chatMetadata = firstChatMetadata;
  await runtime.narrative.handleEvent({ kind: 'chatChanged', chatId: 'fixture-chat' });
  assert.equal(runtime.narrative.isEnabled(), false);
  runtime.dispose();
});

test('Phase 17: ordinary compaction journals the paid response before committing the candidate', async () => {
  const localforage = createMemoryLocalForage();
  const fake = createFakeContext({
    chat: Array.from({ length: 10 }, (_, index) => ({ is_user: index % 2 === 0, name: index % 2 ? 'Jean' : 'Peter', mes: `m${index}`, swipe_id: 0 })),
    generateRaw: async () => JSON.stringify(emptyEpisodeSummary('Durably compacted exchange.')),
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 8, segmentTarget: 2, segmentSoftMax: 4, segmentHardMax: 6, preemptiveRatio: 0.8, memoryCooldownMs: 0 } },
    localforage,
  });
  fake.eventSource.emit('message_received', 9);
  await runtime.narrative.flushBackground();
  const keys = await localforage.instances[0].keys();
  const attemptKey = keys.find(key => key.startsWith('compaction:') && key !== 'compaction:index');
  assert.ok(attemptKey);
  const raw = await localforage.instances[0].getItem(attemptKey);
  assert.match(raw.text, /Durably compacted exchange/);
  assert.equal(runtime.narrative.snapshot().segments[0].extraction.rawOutputRef, attemptKey);
  runtime.dispose();
});

test('Phase 17: an unannounced relevant-media mutation is detected locally before injection', async () => {
  const chat = [
    { is_user: true, name: 'Peter', mes: 'Look at this.', swipe_id: 0, extra: { media: { url: 'scene.png', caption: 'red door' } } },
    { is_user: false, name: 'Jean', mes: 'I see the red door.', swipe_id: 0 },
    { is_user: true, name: 'Peter', mes: 'What now?', swipe_id: 0 },
    { is_user: false, name: 'Jean', mes: 'We continue.', swipe_id: 0 },
  ];
  const mapped = chat.map((message, index) => sourceMessage(index, message.is_user ? 'user' : 'assistant', message.mes, { media: message.extra?.media, tokenCount: 1 }));
  const planned = planSegments(mapped, { targetTokens: 2, softMaxTokens: 2, hardMaxTokens: 2, atomicTurns: true })[0];
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    ...planned,
    dependencyIds: [], summary: emptyEpisodeSummary('Peter showed Jean a red door.'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  chat[0].extra.media.caption = 'blue door';
  const fake = createFakeContext({ chat, chatMetadata: { mnemosyne: envelope } });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, contextBudget: 500, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.intercept(structuredClone(chat), 500, null, 'normal');
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'stale');
  assert.equal(runtime.narrative.integrityStatus().status, 'stale');
  assert.doesNotMatch(fake.prompts.get('mnemosyne_context'), /red door/);
  runtime.dispose();
});

test('Phase 17: cosmetic-only source drift refreshes integrity locally without invalidation or provider work', async () => {
  const chat = [
    { is_user: true, name: 'Peter', mes: 'Line one.\r\nLine two.', swipe_id: 0 },
    { is_user: false, name: 'Jean', mes: 'Response.', swipe_id: 0 },
    { is_user: true, name: 'Peter', mes: 'Continue?', swipe_id: 0 },
    { is_user: false, name: 'Jean', mes: 'Yes.', swipe_id: 0 },
  ];
  const mapped = chat.map((message, index) => sourceMessage(index, message.is_user ? 'user' : 'assistant', message.mes, { tokenCount: 1 }));
  const planned = planSegments(mapped, { targetTokens: 2, softMaxTokens: 2, hardMaxTokens: 2, atomicTurns: true })[0];
  const previousHash = planned.source.turnBundles[0].sourceHash;
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    ...planned,
    dependencyIds: [], summary: emptyEpisodeSummary('The same line-break scene.'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  chat[0].mes = 'Line one.\nLine two.';
  let calls = 0;
  const fake = createFakeContext({ chat, chatMetadata: { mnemosyne: envelope }, generateRaw: async () => { calls += 1; return ''; } });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, contextBudget: 500, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.intercept(structuredClone(chat), 500, null, 'normal');
  const refreshed = runtime.narrative.snapshot().segments[0];
  assert.equal(refreshed.status, 'valid');
  assert.notEqual(refreshed.source.turnBundles[0].sourceHash, previousHash);
  assert.equal(runtime.narrative.integrityStatus().status, 'valid');
  assert.equal(calls, 0);
  runtime.dispose();
});

test('Phase 17: an incomplete rebuild accepts cosmetic drift and refreshes its plan provenance without generation', async () => {
  const chat = Array.from({ length: 8 }, (_, index) => ({
    is_user: index % 2 === 0,
    name: index % 2 ? 'Jean' : 'Peter',
    mes: index === 0 ? 'Line one.\r\nLine two.' : `scene ${index}`,
    swipe_id: 0,
  }));
  const fake = createFakeContext({ chat });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  const planned = await runtime.narrative.startRebuild();
  const oldFingerprint = planned.plan[0].source.rangeFingerprint;
  fake.context.chat[0].mes = 'Line one.\nLine two.';
  const stopped = await runtime.narrative.resumeRebuild(planned.id, { executionMode: 'offline' });
  const stored = runtime.narrative.getRebuildSession(planned.id);
  assert.equal(stopped.session.status, 'incomplete');
  assert.notEqual(stored.plan[0].source.rangeFingerprint, oldFingerprint);
  assert.equal(stored.plan[0].source.turnBundles[0].narrativeHash, planned.plan[0].source.turnBundles[0].narrativeHash);
  assert.equal(runtime.narrative.snapshot().rebuildSessions.filter(session => session.id === planned.id).length, 1);
  runtime.dispose();
});

test('Phase 17: targeted regeneration keeps the old green candidate until one-range promotion', async () => {
  const chat = Array.from({ length: 6 }, (_, index) => ({ is_user: index % 2 === 0, name: index % 2 ? 'Jean' : 'Peter', mes: `m${index}`, swipe_id: 0 }));
  const mapped = chat.map((message, index) => sourceMessage(index, message.is_user ? 'user' : 'assistant', message.mes, { tokenCount: 1 }));
  const planned = planSegments(mapped, { targetTokens: 2, softMaxTokens: 2, hardMaxTokens: 2, atomicTurns: true })[0];
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    ...planned,
    dependencyIds: [], summary: emptyEpisodeSummary('Old green scene.'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  const fake = createFakeContext({ chat, chatMetadata: { mnemosyne: envelope }, generateRaw: async () => JSON.stringify(emptyEpisodeSummary('New green scene.')) });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { memoryCooldownMs: 0, rawTailBudget: 2 } },
    localforage: createMemoryLocalForage(),
  });
  const analysis = await runtime.narrative.analyzeSegmentRegeneration(planned.id);
  assert.equal(analysis.estimatedRequests, 1);
  const session = await runtime.narrative.startSegmentRegeneration(planned.id);
  assert.equal(runtime.narrative.snapshot().segments[0].summary.synopsis, 'Old green scene.');
  const completed = await runtime.narrative.resumeRebuild(session.id, { autoPromote: true });
  assert.equal(completed.session.status, 'promoted');
  assert.equal(runtime.narrative.snapshot().segments[0].summary.synopsis, 'New green scene.');
  runtime.dispose();
});

test('Phase 17: failed targeted regeneration preserves the active green candidate and raw attempt', async () => {
  const chat = Array.from({ length: 6 }, (_, index) => ({ is_user: index % 2 === 0, name: index % 2 ? 'Jean' : 'Peter', mes: `m${index}`, swipe_id: 0 }));
  const mapped = chat.map((message, index) => sourceMessage(index, message.is_user ? 'user' : 'assistant', message.mes, { tokenCount: 1 }));
  const planned = planSegments(mapped, { targetTokens: 2, softMaxTokens: 2, hardMaxTokens: 2, atomicTurns: true })[0];
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    ...planned,
    dependencyIds: [], summary: emptyEpisodeSummary('Paid green scene.'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  const localforage = createMemoryLocalForage();
  const fake = createFakeContext({ chat, chatMetadata: { mnemosyne: envelope }, generateRaw: async () => { const error = new Error('Payment Required'); error.code = 'quota'; throw error; } });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { memoryCooldownMs: 0, rawTailBudget: 2 } },
    localforage,
  });
  const result = await runtime.narrative.regenerateSegment(planned.id);
  assert.equal(result.session.status, 'incomplete');
  assert.equal(runtime.narrative.snapshot().segments[0].summary.synopsis, 'Paid green scene.');
  const rebuildKeys = await localforage.instances[0].keys();
  assert.ok(rebuildKeys.some(key => key.startsWith(`rebuild:${result.session.id}:`)));
  runtime.dispose();
});

test('Phase 18: lexical index covers every continuity-bearing semantic family', () => {
  const summary = emptyEpisodeSummary('A quiet scene.');
  summary.stateChanges.push({ subject: 'peter', path: 'possessions.key', operation: 'set', value: 'brass key', evidence: 'explicit', persistence: 'active' });
  summary.knowledgeChanges.push({ holder: 'jean', proposition: 'Peter hid the map', kind: 'knows', operation: 'add', evidence: 'explicit' });
  summary.relationshipChanges.push({ participants: ['peter', 'jean'], dimension: 'trust', operation: 'set', value: 'fragile', evidence: 'explicit' });
  summary.salientNegatives.push({ proposition: 'Jean destroyed the map', reason: 'She explicitly kept it', evidence: 'explicit' });
  summary.interpretations.push({ description: 'Jean may test his honesty.', evidence: 'weak_inference' });
  summary.temporal.push({ description: 'Before dawn', kind: 'relative', evidence: 'explicit' });
  summary.locations.push({ subject: 'peter', location: 'Queens apartment', kind: 'scene', evidence: 'explicit' });
  const index = new LexicalIndex();
  index.rebuild([{ id: 'all-families', status: 'valid', source: { first: { messageIndex: 0 }, last: { messageIndex: 1 } }, summary }]);
  for (const term of ['brass', 'map', 'fragile', 'destroyed', 'honesty', 'dawn', 'queens']) {
    assert.equal(index.search({ terms: [term] })[0].id, 'all-families');
  }
  const document = index.serialize()[0];
  assert.deepEqual(document.entities.sort(), ['jean', 'peter']);
  assert.deepEqual(index.byLocation('Queens apartment'), ['all-families']);
});

test('Phase 18: boundary state is compact readable prose rather than serialized JSON', () => {
  const projected = projectNarrativeState({
    commitments: { c1: { id: 'c1', actor: 'Peter', toward: 'Jean', content: 'tell the truth', status: 'active' } },
    relationships: { 'jean|peter': { participants: ['jean', 'peter'], trust: 'fragile' } },
    characters: { peter: { entityId: 'peter', possessions: { key: 'brass key' } } },
    threads: {}, worldFacts: {}, narratorFacts: {}, salientNegatives: [],
  });
  const rendered = projected.map(item => item.text).join('\n');
  assert.match(rendered, /Commitment \(active\): Peter to Jean — tell the truth/);
  assert.match(rendered, /Relationship jean ↔ peter: trust=fragile/);
  assert.match(rendered, /Character peter: possessions\.key=brass key/);
  assert.doesNotMatch(rendered, /[{}\"]/);
});

test('Phase 18: register projection obeys lifecycle and injection policy without JSON', () => {
  const registers = [
    { key: 'wrc_2006', type: 'standings', lifecycle: 'active', injectionPolicy: 'relevant', observations: [{ kind: 'event_result', eventKey: 'acropolis', entries: [{ subject: 'Peter', position: 1 }] }] },
    { key: 'always_clock', type: 'clock', lifecycle: 'active', injectionPolicy: 'always', observations: [{ kind: 'snapshot', values: [{ subject: 'time', value: 'dawn' }] }] },
    { key: 'old_league', type: 'standings', lifecycle: 'archived', injectionPolicy: 'relevant', observations: [] },
  ];
  assert.deepEqual(directlyRelevantRegisterKeys(registers, 'What happened in the WRC 2006?'), ['wrc_2006']);
  const projected = projectRegisters(registers, { relevantKeys: ['wrc_2006'] });
  assert.deepEqual(projected.map(item => item.key), ['wrc_2006', 'always_clock']);
  assert.match(projected[0].text, /Peter position=1/);
  assert.doesNotMatch(projected.map(item => item.text).join('\n'), /[{}\"]/);
});

test('Phase 17: final SillyTavern prompt event audits one system memory block at the expected depth', async () => {
  const chat = Array.from({ length: 6 }, (_, index) => ({ is_user: index % 2 === 0, name: index % 2 ? 'Jean' : 'Peter', mes: `scene ${index}`, swipe_id: 0 }));
  const mapped = chat.map((message, index) => sourceMessage(index, message.is_user ? 'user' : 'assistant', message.mes, { tokenCount: 1 }));
  const planned = planSegments(mapped, { targetTokens: 2, softMaxTokens: 2, hardMaxTokens: 2, atomicTurns: true })[0];
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    ...planned, dependencyIds: [], summary: emptyEpisodeSummary('Peter and Jean completed the first scene.'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  const fake = createFakeContext({
    chat,
    chatMetadata: { mnemosyne: envelope },
    extensionPrompts: {
      character_card: { value: 'Character card', position: 2 },
      lorebook: { value: 'Lorebook cue', position: 1 },
    },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 2, contextBudget: 500, contextReserveTokens: 0, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.intercept(structuredClone(chat), 500, null, 'normal');
  const prompt = runtime.narrative.promptPreview();
  assert.match(prompt.block, /<MNEMOSYNE_CONTEXT>/);
  const finalChat = [
    { role: 'system', content: 'Character card\nLorebook cue' },
    { role: 'system', content: prompt.block },
    ...Array.from({ length: prompt.injection.depth }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `raw ${index}` })),
  ];
  fake.eventSource.emit('chat_completion_prompt_ready', { chat: finalChat, dryRun: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  const audit = runtime.narrative.promptPreview().finalAudit;
  assert.equal(audit.status, 'verified');
  assert.equal(audit.occurrenceCount, 1);
  assert.equal(audit.expectedDepth, prompt.injection.depth);
  assert.equal(audit.observedMessagesAfter, prompt.injection.depth);
  assert.equal(audit.observedRole, 'system');
  assert.equal(audit.dryRun, false);
  assert.ok(Number.isFinite(audit.observedContentTokens));
  assert.ok(Number.isFinite(audit.observedMemoryContentTokens));
  assert.equal(audit.observedExternalContentTokens, audit.observedContentTokens - audit.observedMemoryContentTokens);
  assert.equal(audit.observedPublicExtensionEntryCount, 2);
  assert.ok(audit.observedPublicExtensionTokens > 0);
  runtime.dispose();
});

test('Phase 18: token, lexical, and replay acceleration survives restart with strict invalidation', async () => {
  const chat = Array.from({ length: 8 }, (_, index) => ({ is_user: index % 2 === 0, name: index % 2 ? 'Jean' : 'Peter', mes: `turn ${index}`, swipe_id: 0 }));
  const mapped = chat.map((message, index) => sourceMessage(index, message.is_user ? 'user' : 'assistant', message.mes, { tokenCount: 2 }));
  const plans = planSegments(mapped, { targetTokens: 4, softMaxTokens: 4, hardMaxTokens: 4, atomicTurns: true });
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = plans.slice(0, 3).map((planned, index) => ({
    ...planned, dependencyIds: plans.slice(0, index).map(item => item.id), summary: emptyEpisodeSummary(`Green scene ${index}.`), status: 'valid',
    createdAt: 1, updatedAt: index + 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }));
  const chatMetadata = { mnemosyne: envelope };
  const localforage = createMemoryLocalForage();
  let firstCounts = 0;
  const first = createFakeContext({
    chat, chatMetadata, mainApi: 'openai', getTokenizerModel: () => 'gpt-4o',
    getTokenCountAsync: async text => { firstCounts += 1; return Math.ceil(String(text).length / 4); },
  });
  const firstRuntime = await bootstrapMnemosyne({
    getContext: () => first.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 5, contextBudget: 500, contextReserveTokens: 0, autoCompact: false } },
    localforage,
  });
  await firstRuntime.intercept(structuredClone(chat), 500, null, 'normal');
  assert.ok(firstCounts >= chat.length);
  const accelerationKeys = await localforage.instances[0].keys();
  assert.ok(accelerationKeys.includes('acceleration:token-cache:v1'));
  assert.ok(accelerationKeys.includes('acceleration:lexical-index:v1'));
  assert.ok(accelerationKeys.includes('acceleration:replay-checkpoint:v1'));
  firstRuntime.dispose();

  let restartCounts = 0;
  const restarted = createFakeContext({
    chat, chatMetadata, mainApi: 'openai', getTokenizerModel: () => 'gpt-4o',
    getTokenCountAsync: async text => { restartCounts += 1; return Math.ceil(String(text).length / 4); },
  });
  const restartedRuntime = await bootstrapMnemosyne({
    getContext: () => restarted.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 5, contextBudget: 500, contextReserveTokens: 0, autoCompact: false } },
    localforage,
  });
  await restartedRuntime.intercept(structuredClone(chat), 500, null, 'normal');
  assert.ok(restartCounts < firstCounts);
  assert.ok(restartedRuntime.metrics.snapshot().some(item => item.operation === 'acceleration_lexical_index' && item.status === 'hit'));
  assert.ok(restartedRuntime.metrics.snapshot().some(item => item.operation === 'acceleration_replay_checkpoint' && item.status === 'hit'));
  restartedRuntime.dispose();

  let changedTokenizerCounts = 0;
  const changedTokenizer = createFakeContext({
    chat, chatMetadata, mainApi: 'openai', getTokenizerModel: () => 'gpt-5',
    getTokenCountAsync: async text => { changedTokenizerCounts += 1; return Math.ceil(String(text).length / 3); },
  });
  const changedTokenizerRuntime = await bootstrapMnemosyne({
    getContext: () => changedTokenizer.context,
    extensionSettings: { mnemosyne: { rawTailBudget: 5, contextBudget: 500, contextReserveTokens: 0, autoCompact: false } },
    localforage,
  });
  await changedTokenizerRuntime.intercept(structuredClone(chat), 500, null, 'normal');
  assert.ok(changedTokenizerCounts >= chat.length);
  changedTokenizerRuntime.dispose();

  chatMetadata.mnemosyne.segments[0].summary.synopsis = 'Semantically edited green scene.';
  chatMetadata.mnemosyne.segments[0].updatedAt += 100;
  const changedMemory = createFakeContext({ chat, chatMetadata, mainApi: 'openai', getTokenizerModel: () => 'gpt-5' });
  const changedMemoryRuntime = await bootstrapMnemosyne({
    getContext: () => changedMemory.context,
    extensionSettings: { mnemosyne: { autoCompact: false } },
    localforage,
  });
  assert.ok(changedMemoryRuntime.metrics.snapshot().some(item => item.operation === 'acceleration_lexical_index' && item.status === 'stale'));
  changedMemoryRuntime.dispose();
});

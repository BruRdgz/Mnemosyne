import test from 'node:test';
import assert from 'node:assert/strict';
import { measureExternalPromptBudget, observeExternalPromptBudget } from '../../src/context/external-prompt-budget.js';
import { StContextAdapter } from '../../src/integration/st-context-adapter.js';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { createTurnBundles, turnBundleFingerprint } from '../../src/domain/turn-bundle.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { createPortableEnvelope } from '../../src/storage/semantic-store.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

test('Phase 18: public extension budget excludes Mnemosyne and hidden prompts while preserving placement metadata', async () => {
  const result = await measureExternalPromptBudget({
    extensionPrompts: {
      mnemosyne_context: { value: 'old memory', position: 1 },
      card: { value: 'card', position: 2, depth: 0, role: 0 },
      lorebook: { value: 'lore', position: 1, scan: true },
      hidden: { value: 'not outgoing', position: -1 },
      legacy: 'legacy',
    },
    countTokens: async text => text.length,
    configuredReserve: 10,
    maximumPromptTokens: 10_000,
  });
  assert.equal(result.registryAvailable, true);
  assert.equal(result.measuredTokens, 14);
  assert.equal(result.measuredEntryCount, 3);
  assert.equal(result.skippedEntryCount, 2);
  assert.equal(result.effectiveReserve, 14);
  assert.equal(result.budgetSource, 'public_extension_prompts+configured_reserve');
  assert.equal(result.coverage, 'public_extension_prompts_plus_configured_reserve');
  assert.deepEqual(result.entries.map(entry => entry.key), ['card', 'lorebook', 'legacy']);
  assert.equal(result.entries[0].depth, 0);
  assert.equal(result.entries[1].scan, true);
});

test('Phase 18: external budget falls back locally and never invokes private prompt-manager state', async () => {
  let privateReads = 0;
  const result = await measureExternalPromptBudget({
    extensionPrompts: { other: { value: '12345678', position: 1 } },
    countTokens: async () => { privateReads += 1; throw new Error('tokenizer unavailable'); },
    maximumPromptTokens: 2_000,
  });
  assert.equal(privateReads, 1);
  assert.equal(result.measuredTokens, 2);
  assert.equal(result.fallbackEntryCount, 1);
  assert.equal(result.entries[0].source, 'estimated_chars_4');
  assert.equal(result.exactFinalPromptItemization, false);
});

test('Phase 18: an explicitly public complete breakdown supersedes registry counts without private coupling', async () => {
  const result = await measureExternalPromptBudget({
    extensionPrompts: {
      card: { value: 'CARD', position: 2 },
      lorebook: { value: 'LORE', position: 1 },
    },
    countTokens: async text => text.length,
    publicBreakdown: {
      source: 'st-public-test-hook',
      phase: 'pre_generation',
      complete: true,
      exact: true,
      totalTokens: 42,
      entries: [
        { key: 'character-card', category: 'card', label: 'Character card', tokens: 17 },
        { key: 'world-info', category: 'lorebook', label: 'World Info', tokens: 25 },
      ],
    },
    maximumPromptTokens: 1_000,
  });
  assert.equal(result.measuredTokens, 42);
  assert.equal(result.measuredEntryCount, 2);
  assert.equal(result.exactFinalPromptItemization, true);
  assert.equal(result.coverage, 'st_public_prompt_breakdown_exact');
  assert.equal(result.budgetSource, 'st_public_prompt_breakdown');
  assert.deepEqual(result.entries.map(entry => entry.key), ['character-card', 'world-info']);
  assert.equal(result.entries[0].source, 'st_public_breakdown');
});

test('Phase 18: a public breakdown containing Mnemosyne cannot claim exact external coverage', async () => {
  const result = await measureExternalPromptBudget({
    extensionPrompts: { mnemosyne_context: { value: 'self', position: 1 } },
    countTokens: async text => text.length,
    publicBreakdown: {
      phase: 'pre_generation', complete: true, exact: true, totalTokens: 50,
      entries: [{ key: 'mnemosyne_context', tokens: 20 }, { key: 'card', tokens: 30 }],
    },
    maximumPromptTokens: 1_000,
  });
  assert.equal(result.measuredTokens, 30);
  assert.equal(result.exactFinalPromptItemization, false);
  assert.equal(result.coverage, 'st_public_prompt_breakdown_partial');
  assert.deepEqual(result.entries.map(entry => entry.key), ['card']);
});

test('Phase 18: public prompt breakdown adapter is optional and ignores failing hooks', async () => {
  const fake = createFakeContext({
    getPublicPromptTokenBreakdown: async () => ({ totalTokens: 12, entries: [{ key: 'card', tokens: 12 }] }),
  });
  const adapter = new StContextAdapter({ getContext: () => fake.context });
  assert.deepEqual(await adapter.publicPromptTokenBreakdown(), { totalTokens: 12, entries: [{ key: 'card', tokens: 12 }] });
  fake.context.getPublicPromptTokenBreakdown = async () => { throw new Error('unavailable'); };
  assert.equal(await adapter.publicPromptTokenBreakdown(), null);
});

test('Phase 18: final-prompt observation matches public extension values without claiming exact prompt-manager itemization', async () => {
  const result = await observeExternalPromptBudget({
    extensionPrompts: {
      card: { value: 'CARD CONTENT', position: 2 },
      lorebook: { value: 'LORE CONTENT', position: 1 },
      hidden: { value: 'HIDDEN', position: -1 },
      mnemosyne_context: { value: '<MNEMOSYNE_CONTEXT>memory', position: 1 },
    },
    chat: [{ role: 'system', content: 'prefix\nCARD CONTENT\nLORE CONTENT\n<MNEMOSYNE_CONTEXT>memory' }],
    countTokens: async text => text.length,
  });
  assert.equal(result.available, true);
  assert.equal(result.matchedEntryCount, 2);
  assert.equal(result.matchedTokens, 24);
  assert.deepEqual(result.entries.map(entry => entry.key), ['card', 'lorebook']);
  assert.equal(result.exactFinalPromptItemization, false);
});

test('Phase 18: runtime applies measured public extension reserve without counting its own injection', async () => {
  const fake = createFakeContext({
    extensionPrompts: {
      character_card: { value: 'A card supplied by ST.', position: 2 },
      lorebook: { value: 'A lore entry supplied by ST.', position: 1 },
      mnemosyne_context: { value: 'stale value must be excluded', position: 1 },
    },
  });
  const adapter = new StContextAdapter({ getContext: () => fake.context });
  assert.equal(adapter.extensionPromptEntries().length, 3);
  assert.equal(adapter.extensionPromptEntries()[0].value, 'A card supplied by ST.');
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { contextBudget: 12_000, contextReserveTokens: 0, rawTailBudget: 20, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.intercept(structuredClone(fake.context.chat), 20_000, null, 'normal');
  const prompt = runtime.narrative.promptPreview();
  assert.ok(prompt.externalPromptBudget.measuredTokens > 0);
  assert.equal(prompt.externalPromptBudget.entries.some(entry => entry.key === 'mnemosyne_context'), false);
  assert.equal(prompt.contextReserveTokens, prompt.externalPromptBudget.measuredTokens);
  assert.equal(prompt.budgetSource, 'public_extension_prompts');
  runtime.dispose();
});

test('Phase 18: runtime consumes a complete public breakdown as the pre-generation reserve', async () => {
  const fake = createFakeContext({
    extensionPrompts: { mnemosyne_context: { value: 'excluded', position: 1 } },
    getPublicPromptTokenBreakdown: async () => ({
      source: 'st-public-test-hook',
      phase: 'pre_generation',
      complete: true,
      exact: true,
      totalTokens: 36,
      entries: [{ key: 'card', category: 'card', tokens: 36 }],
    }),
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { contextBudget: 12_000, contextReserveTokens: 0, rawTailBudget: 20, autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  await runtime.intercept(structuredClone(fake.context.chat), 20_000, null, 'normal');
  const prompt = runtime.narrative.promptPreview();
  assert.equal(prompt.externalPromptBudget.measuredTokens, 36);
  assert.equal(prompt.externalPromptBudget.exactFinalPromptItemization, true);
  assert.equal(prompt.externalPromptBudget.coverage, 'st_public_prompt_breakdown_exact');
  assert.equal(prompt.contextReserveTokens, 36);
  runtime.dispose();
});

test('Phase 18: configured context sub-budgets reach the generation compiler without provider work', async () => {
  const fake = createFakeContext();
  let providerCalls = 0;
  fake.context.generateRaw = async () => { providerCalls += 1; return '{}'; };
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {
      mnemosyne: {
        contextBudget: 4_000,
        contextReserveTokens: 0,
        contextStateBudget: 111,
        contextRegistersBudget: 222,
        contextChronologicalBudget: 333,
        contextAssociativeBudget: 444,
        autoCompact: false,
      },
    },
    localforage: createMemoryLocalForage(),
  });
  await runtime.intercept(structuredClone(fake.context.chat), 4_000, null, 'normal');
  const budgets = runtime.narrative.promptPreview().budgets;
  assert.deepEqual({ state: budgets.state, registers: budgets.registers, chronological: budgets.chronological, associative: budgets.associative }, { state: 111, registers: 222, chronological: 333, associative: 444 });
  assert.equal(providerCalls, 0);
  runtime.dispose();
});

test('Phase 18: SillyTavern metadata rollback restores the previous envelope when durable save fails', async () => {
  const previous = { schemaVersion: 1, chatId: 'fixture-chat', segments: [{ id: 'green' }] };
  let fail = true;
  const fake = createFakeContext({
    chatMetadata: { mnemosyne: structuredClone(previous) },
    saveMetadata: async () => { if (fail) throw new Error('metadata write failed'); },
  });
  const adapter = new StContextAdapter({ getContext: () => fake.context });
  await assert.rejects(adapter.writePortableMemory({ ...previous, segments: [{ id: 'blue' }] }), /metadata write failed/);
  assert.deepEqual(fake.context.chatMetadata.mnemosyne, previous);
  fail = false;
  await adapter.writePortableMemory({ ...previous, segments: [{ id: 'blue' }] });
  assert.deepEqual(fake.context.chatMetadata.mnemosyne.segments, [{ id: 'blue' }]);
});

test('Phase 18: explicit integrity audit is local, marks changed memory raw-only, and never mutates raw chat', async () => {
  const fake = createFakeContext({
    chat: [
      { is_user: true, is_system: false, name: 'User', mes: 'original user', swipe_id: 0 },
      { is_user: false, is_system: false, name: 'Character', mes: 'original answer', swipe_id: 0 },
    ],
  });
  const adapter = new StContextAdapter({ getContext: () => fake.context });
  const sourceMessages = adapter.sourceMessages();
  const source = createSourceRange(sourceMessages, 0);
  const turnBundles = createTurnBundles(sourceMessages);
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    id: segmentIdFromSource(source.rangeFingerprint),
    source: { ...source, turnBundles, turnBundleFingerprint: turnBundleFingerprint(turnBundles) },
    firstIndex: 0,
    lastIndex: 1,
    dependencyIds: [],
    sourceTokenCount: 2,
    summary: emptyEpisodeSummary('Original scene.'),
    status: 'valid',
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    promptVersion: 2,
    manuallyEdited: false,
    pinned: false,
    extraction: { replacementEligible: true },
  }];
  fake.context.chatMetadata = { mnemosyne: envelope };
  let providerCalls = 0;
  fake.context.generateRaw = async () => { providerCalls += 1; return '{}'; };
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  fake.context.chat[0].mes = 'edited user';
  const rawAfterEdit = structuredClone(fake.context.chat);
  const result = await runtime.auditIntegrity();
  assert.equal(result.status, 'stale');
  assert.equal(result.staleSegments, 1);
  assert.equal(providerCalls, 0);
  assert.deepEqual(fake.context.chat, rawAfterEdit);
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'stale');
  runtime.dispose();
});

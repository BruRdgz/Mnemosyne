import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenGuard, TokenLimitError } from '../../src/observability/token-guard.js';
import { MemoryGenerationAdapter } from '../../src/integration/memory-generation-adapter.js';
import { AccelerationStore } from '../../src/integration/acceleration-store.js';
import { ExtractionEngine } from '../../src/extraction/extraction-engine.js';
import { compileExtractionRequest } from '../../src/extraction/request-compiler.js';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { createMemoryLocalForage } from '../helpers/fakes.js';

const countTokens = async text => String(text).trim() ? String(text).trim().split(/\s+/).length : 0;

function settings(overrides = {}) {
  return { memorySessionTokenCap: 0, memoryDailyTokenCap: 0, ...overrides };
}

function memoryLedger(entries = []) {
  return {
    entries: structuredClone(entries),
    async tokenLedgerForDay() { return structuredClone(this.entries); },
    async appendTokenLedger(entry) { this.entries.push(structuredClone(entry)); },
  };
}

function request(maxTokens = 5) {
  return { systemPrompt: 'system instruction', prompt: 'target narrative text', maxTokens };
}

test('Phase 18: token guard accounts nominal input plus output without pricing or provider lock-in', async () => {
  const ledger = memoryLedger();
  const guard = new TokenGuard({ ledger, settings: settings({ memorySessionTokenCap: 1_000 }), countTokens, getChatId: () => 'chat-a' });
  const adapter = guard.wrap({ async generate() {
    return { text: 'answer', requestId: 'request-1', model: 'generic-model', usage: { nominalInputTokens: 10, cachedInputTokens: 7, uncachedInputTokens: 3, outputTokens: 5 } };
  } });

  await adapter.generate(request());

  const status = guard.status();
  assert.equal(status.sessionSpentTokens, 15);
  assert.equal(status.sessionRemainingTokens, 985);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].totalTokens, 15);
  assert.equal(ledger.entries[0].usageSource, 'provider');
  assert.equal('credits' in ledger.entries[0], false);
  assert.equal('pricing' in ledger.entries[0], false);
});

test('Phase 18: preflight reserves rendered input plus maximum output and blocks before the provider', async () => {
  let providerCalls = 0;
  const guard = new TokenGuard({ ledger: memoryLedger(), settings: settings({ memorySessionTokenCap: 8 }), countTokens });
  const adapter = guard.wrap({ async generate() { providerCalls += 1; return { text: 'unused' }; } });

  await assert.rejects(adapter.generate(request(5)), error => {
    assert.equal(error.code, 'token_limit');
    assert.equal(error.details.reason, 'session_cap');
    assert.equal(error.details.projectedTokens, 10);
    return true;
  });
  assert.equal(providerCalls, 0);
  assert.equal(guard.status().reservedTokens, 0);
});

test('Phase 18: missing or null provider usage is locally estimated and explicitly labeled', async () => {
  const ledger = memoryLedger();
  const guard = new TokenGuard({ ledger, settings: settings(), countTokens });
  const adapter = guard.wrap({ async generate() { return { text: 'three output words', usage: { nominalInputTokens: null, outputTokens: null } }; } });

  await adapter.generate(request(5));

  assert.equal(ledger.entries[0].usageSource, 'estimated');
  assert.equal(ledger.entries[0].usage.nominalInputTokens, 5);
  assert.equal(ledger.entries[0].usage.outputTokens, 3);
  assert.equal(ledger.entries[0].totalTokens, 8);
});

test('Phase 18: daily token usage persists globally across store instances', async () => {
  const localforage = createMemoryLocalForage();
  const firstStore = new AccelerationStore(localforage);
  await firstStore.appendTokenLedger({ id: 'entry-1', day: '2026-08-14', executionMode: 'live', totalTokens: 21 });
  const secondStore = new AccelerationStore(localforage);
  const loaded = await secondStore.tokenLedgerForDay('2026-08-14');

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].totalTokens, 21);
  assert.equal(localforage.instances.at(-1).options.storeName, 'global_token_ledger');
});

test('Phase 18: an unhealthy daily ledger safely blocks the next live request', async () => {
  let providerCalls = 0;
  const ledger = {
    async tokenLedgerForDay() { return []; },
    async appendTokenLedger() { throw new Error('disk full'); },
  };
  const guard = new TokenGuard({ ledger, settings: settings({ memoryDailyTokenCap: 1_000 }), countTokens });
  const adapter = guard.wrap({ async generate() {
    providerCalls += 1;
    return { text: 'ok', usage: { nominalInputTokens: 4, outputTokens: 1 } };
  } });

  await adapter.generate(request(5));
  assert.equal(providerCalls, 1);
  assert.equal(guard.status().ledgerHealthy, false);
  await assert.rejects(adapter.generate(request(5)), error => error instanceof TokenLimitError && error.details.reason === 'ledger_unavailable');
  assert.equal(providerCalls, 1);
});

test('Phase 18: token-limit is terminal for extraction and never triggers a fallback retry', async () => {
  const messages = [{ index: 0, role: 'user', text: 'Target text', tokenCount: 2, swipeId: 0 }];
  const source = createSourceRange(messages, 0);
  const segment = {
    id: segmentIdFromSource(source.rangeFingerprint), source, dependencyIds: [], sourceTokenCount: 2,
    summary: null, status: 'pending', createdAt: 1, updatedAt: 1, schemaVersion: 1,
    promptVersion: 1, manuallyEdited: false, pinned: false,
  };
  const extractionRequest = compileExtractionRequest({ target: { firstIndex: 0, lastIndex: 0, messages } });
  let calls = 0;
  const engine = new ExtractionEngine({ generationAdapter: { async generate() {
    calls += 1;
    throw new TokenLimitError('cap reached', { reason: 'session_cap' });
  } } });

  const result = await engine.extract({ segment, request: extractionRequest, maxRetries: 3 });

  assert.equal(calls, 1);
  assert.equal(result.segment.status, 'failed');
  assert.equal(result.segment.extraction.failure, 'token_limit');
  assert.equal(result.retries, 0);
});

test('Phase 18: cancellation settles a provider that ignores AbortSignal on every supported route', async () => {
  const routes = [
    {
      name: 'generateRaw',
      context: { generateRaw: ({ signal }) => delayedProvider(signal) },
      request: { jsonSchema: null },
      assertRoute: context => context.generateRaw,
    },
    {
      name: 'voidai_json_object',
      context: {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://voidai.app/v1', custom_model: 'fixture', custom_include_body: '' },
        ChatCompletionService: { processRequest: (...args) => delayedProvider(args.at(-1)) },
        getChatCompletionModel: () => 'fixture',
      },
      request: { jsonSchema: { type: 'object' } },
      assertRoute: context => context.ChatCompletionService,
    },
    {
      name: 'connection_profile',
      context: { ConnectionManagerRequestService: { sendRequest: (...args) => delayedProvider(args.at(-1)?.signal) } },
      request: { profileId: 'profile-a', jsonSchema: null },
      assertRoute: context => context.ConnectionManagerRequestService,
    },
  ];

  for (const route of routes) {
    const controller = new AbortController();
    let observedSignal = null;
    const context = { ...route.context };
    if (route.name === 'voidai_json_object') context.ChatCompletionService = { ...context.ChatCompletionService };
    if (route.name === 'connection_profile') context.ConnectionManagerRequestService = { ...context.ConnectionManagerRequestService };
    if (route.name === 'generateRaw') context.generateRaw = ({ signal }) => { observedSignal = signal; return delayedProvider(signal); };
    if (route.name === 'voidai_json_object') context.ChatCompletionService.processRequest = (...args) => { observedSignal = args.at(-1); return delayedProvider(args.at(-1)); };
    if (route.name === 'connection_profile') context.ConnectionManagerRequestService.sendRequest = (...args) => { observedSignal = args.at(-1)?.signal; return delayedProvider(observedSignal); };
    const adapter = new MemoryGenerationAdapter({ getContext: () => context });
    const pending = adapter.generate({ ...route.request, systemPrompt: 'system', prompt: 'target', signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(new Error(`${route.name} cancelled`));
    await assert.rejects(pending, error => /cancelled|aborted/i.test(String(error?.message)));
    assert.equal(observedSignal, controller.signal, `${route.name} did not receive the abort signal`);
    assert.ok(route.assertRoute(context));
  }
});

function delayedProvider() {
  return new Promise(resolve => setTimeout(() => resolve({ content: 'late response' }), 50));
}

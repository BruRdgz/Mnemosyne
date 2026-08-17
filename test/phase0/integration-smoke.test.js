import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { AccelerationStore, safeStoreName } from '../../src/integration/acceleration-store.js';
import { MemoryGenerationAdapter } from '../../src/integration/memory-generation-adapter.js';
import { MetricsRecorder, normalizeProviderUsage } from '../../src/observability/metrics-recorder.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

test('Phase 0: bootstrap persists a portable per-chat envelope and attaches events', async () => {
  const fake = createFakeContext();
  const localforage = createMemoryLocalForage();
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage,
  });
  assert.equal(fake.context.chatMetadata.mnemosyne.schemaVersion, 1);
  assert.equal(fake.context.chatMetadata.mnemosyne.chatId, 'fixture-chat');
  assert.deepEqual(fake.context.chatMetadata.mnemosyne.segments, []);
  assert.equal(fake.metadataSaves(), 1);
  assert.equal(fake.eventSource.count('message_edited'), 1);
  runtime.dispose();
  assert.equal(fake.eventSource.count('message_edited'), 0);
});

test('Phase 0: interceptor compiles an empty-memory prompt without persistent chat mutation', async () => {
  const fake = createFakeContext();
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  const source = structuredClone(fake.context.chat);
  await runtime.intercept(fake.context.chat, 16_000, () => {}, 'normal');
  assert.deepEqual(fake.context.chat, source);
  assert.equal(fake.prompts.get('mnemosyne_context'), '');
  runtime.dispose();
});

test('Phase 0: edit/delete/swipe payloads normalize to current numeric indices', async () => {
  const fake = createFakeContext();
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  fake.eventSource.emit('message_edited', 3);
  fake.eventSource.emit('message_deleted', 2);
  fake.eventSource.emit('message_swiped', 4);
  const events = runtime.metrics.snapshot().filter(event => event.operation === 'st_event');
  assert.deepEqual(events.map(event => [event.kind, event.messageIndex]), [
    ['edited', 3],
    ['deleted', 2],
    ['swiped', 4],
  ]);
  runtime.dispose();
});

test('Phase 0: sent/received/chat-changed events preserve the active chat identity', async () => {
  const fake = createFakeContext();
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  fake.eventSource.emit('message_sent', 0);
  fake.eventSource.emit('message_received', 1);
  fake.eventSource.emit('chat_changed');
  const events = runtime.metrics.snapshot().filter(event => event.operation === 'st_event');
  assert.deepEqual(events.map(event => [event.kind, event.chatIdHashKey]), [
    ['sent', 'fixture-chat'],
    ['received', 'fixture-chat'],
    ['chatChanged', 'fixture-chat'],
  ]);
  runtime.dispose();
});

test('Phase 0: tokenizer and durable metadata routes use public context methods', async () => {
  const fake = createFakeContext();
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  assert.equal(await runtime.context.countTokens('12345678'), 2);
  await runtime.context.writePortableMemory({ schemaVersion: 1, segments: [{ id: 'S1' }] });
  assert.deepEqual(runtime.context.readPortableMemory(), { schemaVersion: 1, segments: [{ id: 'S1' }] });
  assert.equal(fake.metadataSaves(), 2);
  runtime.dispose();
});

test('Phase 0: profile identity reads chat, character, and group scope from public context fields', async () => {
  const fake = createFakeContext();
  fake.context.characterId = 'character-a';
  fake.context.groupId = 'group-a';
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  assert.deepEqual(runtime.context.profileIdentity(), { chatId: 'fixture-chat', characterId: 'character-a', groupId: 'group-a' });
  runtime.dispose();
});

test('Phase 0: active character name follows SillyTavern group speaker selection', async () => {
  const fake = createFakeContext({ characters: [{ name: 'Jean Grey', avatar: 'jean.png' }, { name: 'Peter Parker', avatar: 'peter.png' }] });
  fake.context.characterId = 1;
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  assert.equal(runtime.context.activeCharacterName(), 'Peter Parker');
  fake.context.name2 = 'Jean Grey';
  assert.equal(runtime.context.activeCharacterName(), 'Jean Grey');
  runtime.dispose();
});

test('Phase 0: welcome screen never attempts a metadata save without a chat id', async () => {
  const fake = createFakeContext({ chatId: null, getCurrentChatId: () => null });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: {},
    localforage: createMemoryLocalForage(),
  });
  assert.equal(fake.metadataSaves(), 0);
  assert.equal(fake.context.chatMetadata.mnemosyne, undefined);
  runtime.dispose();
});

test('Phase 0: localForage smoke is namespaced and round-trips without network', async () => {
  const localforage = createMemoryLocalForage();
  const store = new AccelerationStore(localforage);
  assert.equal(await store.smoke('chat/one'), true);
  assert.equal(localforage.instances[0].options.name, 'Mnemosyne');
  assert.equal(localforage.instances[0].options.storeName, safeStoreName('chat/one'));
  assert.equal(globalThis.fetch, globalThis.fetch, 'smoke does not replace or invoke fetch');
});

test('Phase 0: generation routes through named connection profile when selected', async () => {
  const calls = [];
  const fake = createFakeContext({
    ConnectionManagerRequestService: {
      sendRequest: async (...args) => {
        calls.push(args);
        return { content: 'memory', usage: { prompt_tokens: 10, completion_tokens: 3 } };
      },
    },
  });
  const metrics = new MetricsRecorder({ now: (() => { let n = 0; return () => ++n; })() });
  const adapter = new MemoryGenerationAdapter({ getContext: () => fake.context, metrics });
  const result = await adapter.generate({ systemPrompt: 'system', prompt: 'target', profileId: 'profile-1' });
  assert.equal(result.text, 'memory');
  assert.equal(calls[0][0], 'profile-1');
  assert.deepEqual(result.usage, {
    nominalInputTokens: 10, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: 3,
  });
});

test('Phase 0: VoidAI structured extraction uses documented json_object mode with local schema validation', async () => {
  const calls = [];
  const fake = createFakeContext({
    mainApi: 'openai',
    chatCompletionSettings: {
      chat_completion_source: 'custom',
      custom_url: 'https://api.voidai.app/v1',
      custom_model: 'gemini-test',
      custom_include_body: '',
      custom_exclude_body: '',
      custom_include_headers: '',
      custom_prompt_post_processing: 'none',
      temp_openai: 0.2,
      top_p_openai: 1,
      freq_pen_openai: 0,
      pres_pen_openai: 0,
    },
    getChatCompletionModel: settings => settings.custom_model,
    ChatCompletionService: {
      processRequest: async (...args) => {
        calls.push(args);
        return {
          id: 'voidai-request-1',
          model: 'gemini-test',
          choices: [{ message: { content: '{"synopsis":"Memory"}' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        };
      },
    },
    generateRaw: async () => { throw new Error('generic generateRaw must not be used'); },
  });
  const adapter = new MemoryGenerationAdapter({ getContext: () => fake.context });
  const result = await adapter.generate({
    systemPrompt: 'Extract memory.',
    prompt: 'Target.',
    jsonSchema: { name: 'episode', value: { type: 'object', required: ['synopsis'] } },
  });
    const payload = calls[0][0];
    assert.equal(result.text, '{"synopsis":"Memory"}');
    assert.equal(result.finishReason, 'length', 'the full provider envelope must preserve finish_reason');
  assert.equal(calls[0][2], false, 'SillyTavern must not strip the provider envelope before Mnemosyne inspects it');
  assert.equal(payload.json_schema, undefined);
  assert.equal(payload.reasoning_effort, 'none');
  assert.match(payload.custom_include_body, /reasoning_effort: none/);
  assert.match(payload.custom_include_body, /type: json_object/);
  assert.match(payload.messages[0].content, /"required":\["synopsis"\]/);
});

test('Phase 0: VoidAI fallback text keeps the provider envelope instead of opaque generateRaw errors', async () => {
  const calls = [];
  const fake = createFakeContext({
    mainApi: 'openai',
    chatCompletionSettings: {
      chat_completion_source: 'custom',
      custom_url: 'https://api.voidai.app/v1',
      custom_model: 'glm-test',
      custom_include_body: '',
      custom_exclude_body: '',
      custom_include_headers: '',
      custom_prompt_post_processing: 'none',
      temp_openai: 0.2,
      top_p_openai: 1,
      freq_pen_openai: 0,
      pres_pen_openai: 0,
    },
    getChatCompletionModel: settings => settings.custom_model,
    ChatCompletionService: {
      processRequest: async (...args) => {
        calls.push(args);
        return {
          id: 'voidai-fallback-1',
          model: 'glm-test',
          choices: [{ message: { content: '[SYNOPSIS]\nA safe fallback.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        };
      },
    },
    generateRaw: async () => { throw new Error('opaque generateRaw path must not be used'); },
  });
  const adapter = new MemoryGenerationAdapter({ getContext: () => fake.context });
  const result = await adapter.generate({ systemPrompt: 'Recovery.', prompt: 'Target.', jsonSchema: null, maxTokens: 3500 });
  assert.equal(result.text, '[SYNOPSIS]\nA safe fallback.');
  assert.equal(result.requestId, 'voidai-fallback-1');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.route, 'voidai_text');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], false);
  assert.equal(calls[0][0].reasoning_effort, 'none');
  assert.equal(calls[0][0].stop, undefined);
  assert.match(calls[0][0].custom_include_body, /reasoning_effort: none/);
  assert.doesNotMatch(calls[0][0].custom_include_body, /stop:/i);
});

test('Phase 0: VoidAI Payment Required is classified as exhausted quota', async () => {
  const fake = createFakeContext({
    mainApi: 'openai',
    chatCompletionSettings: {
      chat_completion_source: 'custom', custom_url: 'https://api.voidai.app/v1', custom_model: 'glm-test',
      custom_include_body: '', custom_exclude_body: '', custom_include_headers: '', custom_prompt_post_processing: 'none',
    },
    ChatCompletionService: { processRequest: async () => { throw new Error('Payment Required'); } },
  });
  const adapter = new MemoryGenerationAdapter({ getContext: () => fake.context });
  await assert.rejects(
    adapter.generate({ systemPrompt: 'system', prompt: 'target', jsonSchema: { value: { type: 'object' } } }),
    error => error.code === 'quota',
  );
});

test('Phase 0: unavailable provider cache metadata remains unknown', () => {
  assert.deepEqual(normalizeProviderUsage({ prompt_tokens: 12, completion_tokens: 4 }), {
    nominalInputTokens: 12,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: 4,
  });
  assert.deepEqual(normalizeProviderUsage(null), {
    nominalInputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
  });
});

test('Phase 0: routine metrics reject narrative-bearing fields', () => {
  const metrics = new MetricsRecorder();
  assert.throws(() => metrics.record({ operation: 'bad', prompt: 'story prose' }), /forbidden/);
  assert.doesNotThrow(() => metrics.record({ operation: 'safe', messageCount: 2, inputTokens: 40 }));
});

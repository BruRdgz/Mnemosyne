import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsRecorder, normalizeProviderUsage } from '../../src/observability/metrics-recorder.js';
import { planRawForeground, shouldIncludeMessage } from '../../src/planning/raw-foreground.js';
import { TokenCountCache } from '../../src/planning/token-cache.js';

const message = (role, text, tokenCount, extra = {}) => ({ role, text, tokenCount, ...extra });

test('Phase 2: token cache is keyed by stable fingerprint and tokenizer identity', async () => {
  let calls = 0;
  const cache = new TokenCountCache();
  const adapter = { tokenizerKey: 'llama3', countTokens: async text => (calls += 1, text.length) };
  const input = { role: 'user', text: 'hello', swipeId: 0 };
  const first = await cache.count(input, 0, adapter);
  const second = await cache.count(structuredClone(input), 0, adapter);
  const otherTokenizer = await cache.count(input, 0, { ...adapter, tokenizerKey: 'openai' });
  assert.equal(first.cacheStatus, 'miss');
  assert.equal(second.cacheStatus, 'hit');
  assert.equal(otherTokenizer.cacheStatus, 'miss');
  assert.equal(calls, 2);
  assert.equal(cache.size, 2);
});

test('Phase 2: edited message and active swipe invalidate only their token key', async () => {
  let calls = 0;
  const cache = new TokenCountCache();
  const adapter = { tokenizerKey: 'test', countTokens: async text => (calls += 1, text.length) };
  await cache.count({ role: 'assistant', text: 'one', swipeId: 0 }, 2, adapter);
  await cache.count({ role: 'assistant', text: 'edited', swipeId: 0 }, 2, adapter);
  await cache.count({ role: 'assistant', text: 'edited', swipeId: 1 }, 2, adapter);
  assert.equal(calls, 3);
});

test('Phase 2: deterministic planner fills a contiguous eligible tail within budget', () => {
  const input = [
    message('user', 'u1', 3), message('assistant', 'a1', 3),
    message('user', 'u2', 4), message('assistant', 'a2', 4),
  ];
  const first = planRawForeground(input, { budgetTokens: 11 });
  const second = planRawForeground(structuredClone(input), { budgetTokens: 11 });
  assert.deepEqual(first.indices, [1, 2, 3]);
  assert.equal(first.totalTokens, 11);
  assert.deepEqual(second.indices, first.indices);
});

test('Phase 2: current user turn and following assistant messages are lossless even on overflow', () => {
  const input = [
    message('assistant', 'old', 2),
    message('user', 'exact current wording', 9),
    message('assistant', 'exact response wording', 8),
  ];
  const result = planRawForeground(input, { budgetTokens: 10 });
  assert.deepEqual(result.indices, [1, 2]);
  assert.equal(result.messages[0], input[1]);
  assert.equal(result.messages[1], input[2]);
  assert.equal(result.overflowTokens, 7);
  assert.equal(result.reason, 'required_current_turn_exceeds_budget');
});

test('Phase 2: no message is split at an exact boundary', () => {
  const input = [message('user', 'old', 4), message('assistant', 'new', 6)];
  assert.deepEqual(planRawForeground(input, { budgetTokens: 10 }).indices, [0, 1]);
  assert.deepEqual(planRawForeground(input, { budgetTokens: 9 }).indices, [0, 1], 'current turn is atomic');
  const longer = [message('user', 'old', 4), message('assistant', 'old answer', 4), message('user', 'new', 6)];
  assert.deepEqual(planRawForeground(longer, { budgetTokens: 10 }).indices, [1, 2]);
  assert.deepEqual(planRawForeground(longer, { budgetTokens: 9 }).indices, [2]);
});

test('Phase 2: huge single user message is retained and explicitly reports overflow', () => {
  const huge = message('user', 'verbatim huge message', 50_000);
  const result = planRawForeground([huge], { budgetTokens: 8_000 });
  assert.deepEqual(result.indices, [0]);
  assert.equal(result.withinBudget, false);
  assert.equal(result.overflowTokens, 42_000);
});

test('Phase 2: hidden/system/user inclusion policy is explicit and configurable', () => {
  assert.equal(shouldIncludeMessage(message('system', 'system', 1)), false);
  assert.equal(shouldIncludeMessage(message('assistant', 'hidden', 1, { hidden: true })), false);
  assert.equal(shouldIncludeMessage(message('user', 'user', 1)), true);
  const input = [
    message('system', 'system', 1),
    message('assistant', 'hidden', 1, { hidden: true }),
    message('user', 'visible', 1),
  ];
  assert.deepEqual(planRawForeground(input, { budgetTokens: 10 }).indices, [2]);
  assert.deepEqual(planRawForeground(input, {
    budgetTokens: 10,
    policy: { includeUser: true, includeAssistant: true, includeSystem: true, includeHidden: true },
  }).indices, [0, 1, 2]);
});

test('Phase 2: provider accounting distinguishes cached and uncached tokens when exposed', () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 70 },
    completion_tokens: 12,
  }), {
    nominalInputTokens: 100,
    cachedInputTokens: 70,
    uncachedInputTokens: 30,
    outputTokens: 12,
  });
});

test('Phase 2: absent cache accounting remains unknown', () => {
  const usage = normalizeProviderUsage({ prompt_tokens: 100, completion_tokens: 12 });
  assert.equal(usage.cachedInputTokens, null);
  assert.equal(usage.uncachedInputTokens, null);
});

test('Phase 2: token and planner metrics contain fingerprints/counts but no prose', async () => {
  let tick = 0;
  const metrics = new MetricsRecorder({ now: () => ++tick });
  const cache = new TokenCountCache({ metrics });
  await cache.count({ role: 'user', text: 'secret story prose', swipeId: 0 }, 0, {
    tokenizerKey: 'test', countTokens: async () => 4,
  });
  planRawForeground([message('user', 'secret story prose', 4)], { budgetTokens: 8, metrics });
  const json = JSON.stringify(metrics.snapshot());
  assert.doesNotMatch(json, /secret story prose/);
  assert.match(json, /fingerprint/);
  assert.match(json, /tokenCount/);
});

import { readFile } from 'node:fs/promises';
import { DEFAULT_SETTINGS } from '../src/core/constants.js';
import { compileExtractionRequest } from '../src/extraction/request-compiler.js';
import { planRawForeground, shouldIncludeMessage } from '../src/planning/raw-foreground.js';
import { computeCompactionFrontier, planSegments } from '../src/planning/segment-planner.js';

function optionsOf(argv) {
  const options = { baseUrl: 'http://127.0.0.1:8000' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--chat') options.chatPath = argv[++index];
    else if (argv[index] === '--base-url') options.baseUrl = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.chatPath) throw new Error('Usage: node scripts/qualify-live-rebuild.mjs --chat <absolute-jsonl-path>');
  return options;
}

async function tokenizer(baseUrl) {
  const csrf = await fetch(`${baseUrl}/csrf-token`);
  if (!csrf.ok) throw new Error(`CSRF bootstrap failed with HTTP ${csrf.status}`);
  const cookies = (csrf.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
  const { token } = await csrf.json();
  return async text => {
    const response = await fetch(`${baseUrl}/api/tokenizers/openai/count?model=gemini`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: cookies },
      body: JSON.stringify([{ content: String(text) }]),
    });
    if (!response.ok) throw new Error(`Tokenizer failed with HTTP ${response.status}`);
    const result = await response.json();
    return Math.max(1, Number(result.token_count));
  };
}

const options = optionsOf(process.argv.slice(2));
const rows = String(await readFile(options.chatPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const messages = rows.slice(1).map((message, index) => ({
  index,
  role: message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'),
  name: String(message.name ?? ''),
  text: String(message.mes ?? ''),
  hidden: Boolean(message.is_system || message.extra?.type === 'system'),
  swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : 0,
  sendDate: message.send_date ?? null,
  original: message,
}));
const countTokens = await tokenizer(options.baseUrl);
const counted = await Promise.all(messages.map(async message => ({ ...message, tokenCount: await countTokens(message.text) })));
const narrative = counted.filter(message => shouldIncludeMessage(message));
const raw = planRawForeground(counted, { budgetTokens: DEFAULT_SETTINGS.rawTailBudget });
const frontier = computeCompactionFrontier(narrative, raw, { preemptiveRatio: DEFAULT_SETTINGS.preemptiveRatio });
const eligible = counted.filter(message => shouldIncludeMessage(message) && message.index <= frontier.eligibleThroughIndex);
const plan = planSegments(eligible, {
  targetTokens: DEFAULT_SETTINGS.segmentTarget,
  softMaxTokens: DEFAULT_SETTINGS.segmentSoftMax,
  hardMaxTokens: DEFAULT_SETTINGS.segmentHardMax,
  atomicTurns: true,
});

let prefixTokens = null;
let baseInputTokens = 0;
let likelyInputTokens = 0;
let maximumInputTokens = 0;
const contextCapacity = DEFAULT_SETTINGS.extractionStateBudget
  + DEFAULT_SETTINGS.extractionChronologicalBudget
  + DEFAULT_SETTINGS.extractionHistoricalBudget
  + DEFAULT_SETTINGS.extractionRawPreludeBudget;
for (const item of plan) {
  const target = { ...item, messages: counted.filter(message => message.index >= item.firstIndex && message.index <= item.lastIndex) };
  const request = compileExtractionRequest({ target, stateAtStart: null, previousSummaries: [], olderMemories: [], rawPrelude: [], budgets: { stateTokens: 0, chronologicalTokens: 0, historicalTokens: 0, rawPreludeTokens: 0 } });
  const providerPrefix = `${request.systemPrompt}\n\nVoidAI JSON mode is active. Return exactly one JSON object, without Markdown or commentary. The object must satisfy this JSON Schema; validation is performed locally:\n${JSON.stringify(request.jsonSchema.promptValue ?? request.jsonSchema.value)}`;
  prefixTokens ??= await countTokens(providerPrefix);
  const base = await countTokens(`${providerPrefix}\n${request.prompt}`);
  baseInputTokens += base;
  likelyInputTokens += Math.min(DEFAULT_SETTINGS.extractionInputBudget, base + contextCapacity);
  maximumInputTokens += Math.min(DEFAULT_SETTINGS.extractionInputBudget, base + contextCapacity);
}
maximumInputTokens = Math.max(baseInputTokens, Math.min(maximumInputTokens, DEFAULT_SETTINGS.rebuildTotalInputBudget));
likelyInputTokens = Math.min(maximumInputTokens, baseInputTokens + Math.round((maximumInputTokens - baseInputTokens) * 0.75));
const requests = plan.length;
const credits = (input, output) => input * DEFAULT_SETTINGS.memoryPricingInputMultiplier + output * DEFAULT_SETTINGS.memoryPricingOutputMultiplier;
const report = {
  mode: 'read-only-local-qualification',
  messageCount: counted.length,
  eligibleMessageCount: eligible.length,
  eligibleSourceTokens: eligible.reduce((sum, message) => sum + message.tokenCount, 0),
  rawForeground: { indices: raw.indices, tokens: raw.totalTokens },
  requests,
  ranges: plan.map(item => ({ first: item.firstIndex, last: item.lastIndex, tokens: item.sourceTokenCount, oversized: item.oversized, reason: item.boundaryReason })),
  isolatedUserRanges: plan.filter(item => {
    const last = counted[item.lastIndex];
    return last?.role === 'user' && counted[item.lastIndex + 1]?.role === 'assistant';
  }).length,
  fixedPrefixTokens: prefixTokens,
  projectedInputTokens: { targetOnly: baseInputTokens, likely: likelyInputTokens, maximum: maximumInputTokens },
  projectedOutputTokens: { averageTarget: requests * 3_000, safetyMaximum: requests * DEFAULT_SETTINGS.extractionMaxOutputTokens },
  projectedCredits: {
    lower: credits(likelyInputTokens, requests * 2_500),
    target: credits(maximumInputTokens, requests * 3_000),
  },
  pricing: { input: DEFAULT_SETTINGS.memoryPricingInputMultiplier, output: DEFAULT_SETTINGS.memoryPricingOutputMultiplier, cache: DEFAULT_SETTINGS.memoryPricingCacheMultiplier },
  providerRequestsMade: 0,
  filesWritten: 0,
};
console.log(JSON.stringify(report, null, 2));

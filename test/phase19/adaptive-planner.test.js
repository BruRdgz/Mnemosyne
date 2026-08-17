import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { enumerateAdaptiveCandidates, optimizeAdaptiveSegments } from '../../src/planning/adaptive-segment-planner.js';
import { compileExtractionRequest } from '../../src/extraction/request-compiler.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';

function messages(bundleCount = 12, tokenCount = 100) {
  return Array.from({ length: bundleCount * 2 }, (_, index) => ({ index, role: index % 2 ? 'assistant' : 'user', text: `turn ${index}`, tokenCount }));
}

test('Adaptive planner keeps turn bundles atomic and respects the five-bundle cap', () => {
  const plan = optimizeAdaptiveSegments(messages(12), { inputBudget: 2_000, safetyRatio: 0.8, hardMaxTokens: 900, projectInputTokens: ({ sourceTokenCount }) => sourceTokenCount + 200 });
  assert.equal(plan.recommended.segments.every(segment => segment.bundleCount <= 5), true);
  assert.deepEqual(plan.recommended.segments.flatMap(segment => segment.source.turnBundles).map(bundle => [bundle.firstIndex, bundle.lastIndex]), Array.from({ length: 12 }, (_, index) => [index * 2, index * 2 + 1]));
});

test('Adaptive planner permits an oversized singleton when no safe multi-bundle candidate exists', () => {
  const candidates = enumerateAdaptiveCandidates(messages(3, 900), { inputBudget: 1_000, safetyRatio: 0.8, hardMaxTokens: 2_000, projectInputTokens: ({ sourceTokenCount }) => sourceTokenCount + 300 });
  assert.equal(candidates.filter(candidate => candidate.safe).every(candidate => candidate.bundleCount === 1), true);
  assert.equal(candidates.some(candidate => candidate.oversizedReason === 'input_safety_ceiling'), true);
});

test('Adaptive economic objective matches exhaustive search on a small fixture', () => {
  const options = { inputBudget: 2_500, safetyRatio: 0.8, hardMaxTokens: 1_200, maxBundles: 5, projectInputTokens: ({ sourceTokenCount, bundleCount }) => sourceTokenCount + (bundleCount * 140) + 180 };
  const plan = optimizeAdaptiveSegments(messages(5, 80), options);
  const candidates = enumerateAdaptiveCandidates(messages(5, 80), options).filter(candidate => candidate.safe);
  const paths = cursor => {
    if (cursor === 5) return [{ total: 0 }];
    return candidates.filter(candidate => candidate.unitStart === cursor).flatMap(candidate => paths(candidate.unitEnd + 1).map(next => ({ total: candidate.cost.expectedTotalTokens + next.total })));
  };
  const optimum = Math.min(...paths(0).map(path => path.total));
  assert.equal(plan.alternatives.find(candidate => candidate.objective === 'economic').metrics.expectedTotalTokens, optimum);
});

test('Adaptive plan alternatives are deterministic and expose safety projections', () => {
  const options = { inputBudget: 4_000, safetyRatio: 0.8, hardMaxTokens: 900, projectInputTokens: ({ sourceTokenCount }) => sourceTokenCount + 250 };
  const first = optimizeAdaptiveSegments(messages(9), options);
  const second = optimizeAdaptiveSegments(messages(9), options);
  assert.equal(first.recommended.id, second.recommended.id);
  assert.deepEqual(first.alternatives.map(plan => plan.objective), ['economic', 'fast', 'safe', 'balanced']);
  assert.equal(first.recommended.metrics.maxInputTokens <= first.safetyCeiling, true);
});

test('Runtime analysis is local, returns an adaptive fingerprint, and freezes the selected plan', async () => {
  const fake = createFakeContext({ chat: messages(10).map(message => ({ is_user: message.role === 'user', is_system: false, name: message.role === 'user' ? 'User' : 'Character', mes: message.text, swipe_id: 0 })) });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 500, segmentSoftMax: 700, segmentHardMax: 900, memoryCooldownMs: 0 } }, localforage: createMemoryLocalForage() });
  const analysis = await runtime.narrative.analyzeBackfill({ rebuild: true });
  assert.equal(typeof analysis.analysisFingerprint, 'string');
  assert.equal(analysis.optimization.recommended.objective, 'balanced');
  const session = await runtime.narrative.startRebuild({ analysisFingerprint: analysis.analysisFingerprint, planCandidateId: analysis.recommendedPlanId });
  assert.equal(session.optimization.selectedPlanId, analysis.recommendedPlanId);
  assert.equal(session.config.planner.mode, 'adaptive_balanced');
  await assert.rejects(() => runtime.narrative.startRebuild({ analysisFingerprint: 'stale-analysis' }), /stale|analyze/i);
  runtime.dispose();
});

test('Adaptive analysis fingerprint includes message content and compact retries use the reduced provider schema', async () => {
  const source = messages(6).map(message => ({ is_user: message.role === 'user', is_system: false, name: message.role === 'user' ? 'User' : 'Character', mes: message.text, swipe_id: 0 }));
  const fake = createFakeContext({ chat: source });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 500, segmentSoftMax: 700, segmentHardMax: 900, memoryCooldownMs: 0 } }, localforage: createMemoryLocalForage() });
  const first = await runtime.narrative.analyzeBackfill({ rebuild: true });
  source[0].mes = 'edited source';
  const second = await runtime.narrative.analyzeBackfill({ rebuild: true });
  assert.notEqual(first.analysisFingerprint, second.analysisFingerprint);
  const target = { firstIndex: 0, lastIndex: 1, messages: [
    { index: 0, role: 'user', text: 'A', tokenCount: 1 },
    { index: 1, role: 'assistant', text: 'B', tokenCount: 1 },
  ] };
  const standard = compileExtractionRequest({ target });
  const compact = compileExtractionRequest({ target, schemaVariant: 'compact' });
  assert.equal(compact.jsonSchema.name, 'mnemosyne_episode_extraction_compact');
  assert.ok(JSON.stringify(compact.jsonSchema.promptValue).length < JSON.stringify(standard.jsonSchema.promptValue).length);
  runtime.dispose();
});

test('Adaptive rebuild reuses exact green candidates without a provider call', async () => {
  let calls = 0;
  const source = messages(8).map(message => ({ is_user: message.role === 'user', is_system: false, name: message.role === 'user' ? 'User' : 'Character', mes: message.text, swipe_id: 0 }));
  const fake = createFakeContext({ chat: source, generateRaw: async () => { calls += 1; return JSON.stringify(emptyEpisodeSummary(`candidate ${calls}`)); } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 500, segmentSoftMax: 700, segmentHardMax: 900, memoryCooldownMs: 0 } }, localforage: createMemoryLocalForage() });
  const firstAnalysis = await runtime.narrative.analyzeBackfill({ rebuild: true });
  const first = await runtime.narrative.startRebuild({ analysisFingerprint: firstAnalysis.analysisFingerprint, planCandidateId: firstAnalysis.recommendedPlanId });
  const firstResult = await runtime.narrative.resumeRebuild(first.id);
  assert.equal(firstResult.status, 'complete');
  const callsAfterFirst = calls;
  const secondAnalysis = await runtime.narrative.analyzeBackfill({ rebuild: true });
  assert.equal(secondAnalysis.reusedGreenCount, first.plan.length);
  assert.equal(secondAnalysis.plannedSegmentCount, 0);
  const second = await runtime.narrative.startRebuild({ analysisFingerprint: secondAnalysis.analysisFingerprint, planCandidateId: secondAnalysis.recommendedPlanId });
  const secondResult = await runtime.narrative.resumeRebuild(second.id);
  assert.equal(secondResult.status, 'complete');
  assert.equal(calls, callsAfterFirst);
  assert.equal(secondResult.session.plan.every(item => item.reused), true);
  assert.equal(secondResult.session.plan.every(item => item.reusedFromSessionId === first.id), true);
  runtime.dispose();
});

test('Adaptive length retry keeps the target intact while switching to the compact protocol', async () => {
  let calls = 0;
  const requests = [];
  const source = messages(6).map(message => ({ is_user: message.role === 'user', is_system: false, name: message.role === 'user' ? 'User' : 'Character', mes: message.text, swipe_id: 0 }));
  const fake = createFakeContext({ chat: source, generateRaw: async request => {
    calls += 1;
    requests.push(request);
    return calls === 1 ? '{"synopsis":"unfinished' : JSON.stringify(emptyEpisodeSummary(`candidate ${calls}`));
  } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 500, segmentSoftMax: 700, segmentHardMax: 900, memoryCooldownMs: 0 } }, localforage: createMemoryLocalForage() });
  const analysis = await runtime.narrative.analyzeBackfill({ rebuild: true });
  const session = await runtime.narrative.startRebuild({ analysisFingerprint: analysis.analysisFingerprint, planCandidateId: analysis.recommendedPlanId });
  const stopped = await runtime.narrative.resumeRebuild(session.id);
  assert.equal(stopped.status, 'stopped-on-failure');
  const completed = await runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(requests[1].jsonSchema.name, 'mnemosyne_episode_extraction_compact');
  assert.equal(requests[1].responseLength, 2_500);
  assert.equal(completed.session.attempts[1].protocol, 'repair_compact_v2');
  runtime.dispose();
});

test('Adaptive schema validation failure switches once to the compact repair protocol', async () => {
  let calls = 0;
  const requests = [];
  const source = messages(4).map(message => ({ is_user: message.role === 'user', is_system: false, name: message.role === 'user' ? 'User' : 'Character', mes: message.text, swipe_id: 0 }));
  const fake = createFakeContext({ chat: source, generateRaw: async request => {
    calls += 1;
    requests.push(request);
    return calls === 1 ? '{"synopsis":"only"}' : JSON.stringify(emptyEpisodeSummary(`repaired ${calls}`));
  } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 500, segmentSoftMax: 700, segmentHardMax: 900, memoryCooldownMs: 0 } }, localforage: createMemoryLocalForage() });
  const analysis = await runtime.narrative.analyzeBackfill({ rebuild: true });
  const session = await runtime.narrative.startRebuild({ analysisFingerprint: analysis.analysisFingerprint, planCandidateId: analysis.recommendedPlanId });
  const stopped = await runtime.narrative.resumeRebuild(session.id);
  assert.equal(stopped.status, 'stopped-on-failure');
  assert.equal(stopped.session.segments[0].extraction.failure, 'schema_invalid');
  const completed = await runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(requests[1].jsonSchema.name, 'mnemosyne_episode_extraction_compact');
  assert.equal(requests[1].responseLength, 2_500);
  assert.equal(completed.session.attempts[1].protocol, 'repair_compact_v2');
  runtime.dispose();
});

test('Adaptive compact truncation escalates to the schema-free minimal fallback', async () => {
  let calls = 0;
  const requests = [];
  const source = messages(4).map(message => ({ is_user: message.role === 'user', is_system: false, name: message.role === 'user' ? 'User' : 'Character', mes: message.text, swipe_id: 0 }));
  const fake = createFakeContext({ chat: source, generateRaw: async request => {
    calls += 1;
    requests.push(request);
    if (calls === 1) return '{"synopsis":"unfinished';
    if (calls === 2) return { content: '{"synopsis":"still unfinished', choices: [{ finish_reason: 'length' }] };
    return '[SYNOPSIS]\nRecovered with the minimal fallback.\n[EVENTS]\n- description=The target scene continues | evidence=explicit | salience=normal | domains=general';
  } });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 500, segmentSoftMax: 700, segmentHardMax: 900, memoryCooldownMs: 0 } }, localforage: createMemoryLocalForage() });
  const analysis = await runtime.narrative.analyzeBackfill({ rebuild: true });
  const session = await runtime.narrative.startRebuild({ analysisFingerprint: analysis.analysisFingerprint, planCandidateId: analysis.recommendedPlanId });
  await runtime.narrative.resumeRebuild(session.id);
  await runtime.narrative.resumeRebuild(session.id);
  const completed = await runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(requests[2].jsonSchema, null);
  assert.equal(requests[2].responseLength, 3_500);
  assert.match(requests[2].systemPrompt, /MINIMAL TAGGED FALLBACK|STRUCTURED RECOVERY/i);
  assert.doesNotMatch(requests[2].systemPrompt, /Return exactly one JSON object and nothing else/);
  assert.equal(completed.session.attempts[2].protocol, 'minimal_fallback_v2');
  runtime.dispose();
});

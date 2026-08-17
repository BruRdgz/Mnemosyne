import { fingerprintValue } from '../domain/fingerprint.js';
import { createTurnBundles } from '../domain/turn-bundle.js';
import { makeSegment } from './segment-planner.js';

export const ADAPTIVE_PLANNER_VERSION = 'adaptive_v1';
export const DEFAULT_ADAPTIVE_PLANNER_OPTIONS = Object.freeze({
  targetTokens: 5_000,
  softMaxTokens: 7_000,
  hardMaxTokens: 9_000,
  inputBudget: 8_000,
  maxBundles: 5,
  safetyRatio: 0.8,
  nearOptimalRatio: 1.05,
  safeOverheadRatio: 1.2,
  cooldownMs: 3_000,
  defaultLatencyMs: 2_000,
  retryPrior: 0.2,
});

function roleOf(message) {
  return String(message?.role ?? (message?.is_user ? 'user' : (message?.is_system ? 'system' : 'assistant')));
}

function checkedTokens(message, position) {
  const value = Number(message?.tokenCount);
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`Message at position ${position} lacks a non-negative integer tokenCount`);
  return value;
}

function boundaryScore(message) {
  const value = message?.boundaryHint;
  if (Array.isArray(value)) return Math.max(0, ...value.map(boundaryScore));
  return { chapter: 4, scene: 3, time: 2, location: 1 }[String(value)] ?? 0;
}

function rangeKey(firstIndex, lastIndex) { return `${firstIndex}:${lastIndex}`; }

function uniformityPenalty(values = []) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
}

function turnUnits(messages) {
  const positions = new Map(messages.map((message, position) => [message.index ?? position, position]));
  return createTurnBundles(messages).map(bundle => {
    const start = positions.get(bundle.firstIndex);
    const end = positions.get(bundle.lastIndex);
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('Turn bundle does not map to source positions');
    const sourceTokenCount = messages.slice(start, end + 1).reduce((sum, message, offset) => sum + checkedTokens(message, start + offset), 0);
    return Object.freeze({
      start,
      end,
      firstIndex: bundle.firstIndex,
      lastIndex: bundle.lastIndex,
      sourceTokenCount,
      complete: bundle.complete,
      kind: bundle.kind,
    });
  });
}

function normalizeProjection(projection, fallback) {
  const value = typeof projection === 'number' ? { inputTokens: projection } : (projection ?? {});
  const inputTokens = Number.isFinite(value.inputTokens) ? Math.max(0, Math.round(value.inputTokens)) : fallback;
  const outputTokens = Number.isFinite(value.outputTokens) ? Math.max(0, Math.round(value.outputTokens)) : Math.max(600, Math.round(fallback * 0.45));
  const retryProbability = Number.isFinite(value.retryProbability) ? Math.max(0, Math.min(0.75, value.retryProbability)) : null;
  const attempts = Number.isFinite(value.expectedAttempts) ? Math.max(1, value.expectedAttempts) : null;
  const latencyMs = Number.isFinite(value.latencyMs) ? Math.max(0, value.latencyMs) : null;
  return { ...value, inputTokens, outputTokens, retryProbability, expectedAttempts: attempts, latencyMs };
}

function candidateCost(candidate, options) {
  const p = candidate.projection.retryProbability ?? options.retryPrior;
  const attempts = candidate.projection.expectedAttempts ?? (1 + p + p * p);
  const latency = candidate.projection.latencyMs ?? options.defaultLatencyMs;
  const expectedInput = candidate.projection.inputTokens * attempts;
  const expectedOutput = candidate.projection.outputTokens * attempts;
  const expectedTokens = expectedInput + expectedOutput;
  const expectedWallTimeMs = attempts * (latency + options.cooldownMs);
  return Object.freeze({
    expectedAttempts: attempts,
    expectedRequests: attempts,
    expectedInputTokens: expectedInput,
    expectedOutputTokens: expectedOutput,
    expectedTotalTokens: expectedTokens,
    expectedWallTimeMs,
    maxInputTokens: candidate.projection.inputTokens,
  });
}

function makeCandidate(messages, units, startUnit, endUnit, options, projection) {
  const first = units[startUnit];
  const last = units[endUnit];
  const sourceTokenCount = units.slice(startUnit, endUnit + 1).reduce((sum, unit) => sum + unit.sourceTokenCount, 0);
  const firstIndex = first.firstIndex;
  const lastIndex = last.lastIndex;
  const range = rangeKey(firstIndex, lastIndex);
  const projected = normalizeProjection(projection?.({
    firstIndex,
    lastIndex,
    sourceTokenCount,
    bundleCount: endUnit - startUnit + 1,
    oversized: Boolean(first.sourceTokenCount > options.hardMaxTokens),
  }), sourceTokenCount);
  const safetyCeiling = Math.max(1, Math.floor(options.inputBudget * options.safetyRatio));
  const oversized = first.sourceTokenCount > options.hardMaxTokens || (endUnit === startUnit && projected.inputTokens > safetyCeiling);
  const safe = oversized || projected.inputTokens <= safetyCeiling;
  const sliceStart = first.start;
  const sliceEnd = last.end;
  const segment = makeSegment(messages, sliceStart, sliceEnd, sourceTokenCount, oversized ? 'oversized_turn' : 'adaptive_turn_batch', oversized);
  const cost = candidateCost({ projection: projected }, options);
  return Object.freeze({
    ...segment,
    bundleCount: endUnit - startUnit + 1,
    unitStart: startUnit,
    unitEnd: endUnit,
    range,
    projection: Object.freeze(projected),
    cost,
    safetyCeiling,
    safe,
    boundaryScore: boundaryScore(messages[sliceEnd]),
    oversizedReason: first.sourceTokenCount > options.hardMaxTokens ? 'source_hard_max' : (oversized ? 'input_safety_ceiling' : null),
  });
}

function comparePlans(left, right, objective) {
  const metric = objective === 'fast' ? 'expectedWallTimeMs' : objective === 'safe' ? 'maxInputTokens' : 'expectedTotalTokens';
  return (left.metrics[metric] - right.metrics[metric])
    || (left.metrics.expectedTotalTokens - right.metrics.expectedTotalTokens)
    || (left.metrics.expectedRequests - right.metrics.expectedRequests)
    || (right.metrics.boundaryScore - left.metrics.boundaryScore)
    || (left.metrics.maxInputTokens - right.metrics.maxInputTokens)
    || (left.metrics.uniformityPenalty - right.metrics.uniformityPenalty)
    || (left.segments.length - right.segments.length);
}

function combinePlan(prefix, candidate) {
  const segments = [...prefix.segments, candidate];
  const metrics = {
    expectedAttempts: prefix.metrics.expectedAttempts + candidate.cost.expectedAttempts,
    expectedRequests: prefix.metrics.expectedRequests + candidate.cost.expectedRequests,
    expectedInputTokens: prefix.metrics.expectedInputTokens + candidate.cost.expectedInputTokens,
    expectedOutputTokens: prefix.metrics.expectedOutputTokens + candidate.cost.expectedOutputTokens,
    expectedTotalTokens: prefix.metrics.expectedTotalTokens + candidate.cost.expectedTotalTokens,
    expectedWallTimeMs: prefix.metrics.expectedWallTimeMs + candidate.cost.expectedWallTimeMs,
    maxInputTokens: Math.max(prefix.metrics.maxInputTokens, candidate.cost.maxInputTokens),
    boundaryScore: prefix.metrics.boundaryScore + candidate.boundaryScore,
    uniformityPenalty: uniformityPenalty(segments.map(segment => segment.projection.inputTokens)),
  };
  return { segments, metrics };
}

function dominates(left, right) {
  const keys = ['expectedTotalTokens', 'expectedWallTimeMs', 'maxInputTokens', 'expectedRequests'];
  const noWorse = keys.every(key => left.metrics[key] <= right.metrics[key]);
  const better = keys.some(key => left.metrics[key] < right.metrics[key]);
  return noWorse && better;
}

function pruneFrontier(paths, limit = 256) {
  const unique = new Map();
  for (const path of paths) {
    const key = path.segments.map(segment => segment.range).join('|');
    const previous = unique.get(key);
    if (!previous || path.metrics.expectedTotalTokens < previous.metrics.expectedTotalTokens) unique.set(key, path);
  }
  const frontier = [...unique.values()].filter((path, index, all) => !all.some((other, otherIndex) => otherIndex !== index && dominates(other, path)));
  frontier.sort((left, right) => left.metrics.expectedTotalTokens - right.metrics.expectedTotalTokens || left.metrics.expectedWallTimeMs - right.metrics.expectedWallTimeMs);
  return frontier.slice(0, limit);
}

function objectivePlan(paths, objective) {
  if (!paths.length) return null;
  return [...paths].sort((left, right) => comparePlans(left, right, objective))[0];
}

function decoratePlan(path, objective, options) {
  if (!path) return null;
  const candidateId = fingerprintValue({ planner: ADAPTIVE_PLANNER_VERSION, objective, segments: path.segments.map(segment => ({ id: segment.id, range: segment.range, bundles: segment.bundleCount })) }, 'adaptive-plan');
  return Object.freeze({
    id: candidateId,
    objective,
    plannerVersion: ADAPTIVE_PLANNER_VERSION,
    segments: Object.freeze(path.segments.map(segment => Object.freeze({ ...segment, projectedInputTokens: segment.projection.inputTokens, expectedOutputTokens: segment.projection.outputTokens, expectedAttempts: segment.cost.expectedAttempts, expectedWallTimeMs: segment.cost.expectedWallTimeMs }))),
    metrics: Object.freeze({ ...path.metrics, safetyCeiling: Math.max(...path.segments.map(segment => segment.safetyCeiling), 0), unsafeCount: path.segments.filter(segment => !segment.safe).length, maxBundles: Math.max(...path.segments.map(segment => segment.bundleCount), 0), calibrationConfidence: options.calibrationConfidence ?? 'low' }),
  });
}

export function enumerateAdaptiveCandidates(messages, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  const merged = { ...DEFAULT_ADAPTIVE_PLANNER_OPTIONS, ...options };
  if (!Number.isInteger(merged.maxBundles) || merged.maxBundles < 1) throw new RangeError('maxBundles must be a positive integer');
  if (!(merged.safetyRatio > 0 && merged.safetyRatio <= 1)) throw new RangeError('safetyRatio must be in (0, 1]');
  const units = turnUnits(messages);
  const candidates = [];
  for (let start = 0; start < units.length; start += 1) {
    for (let end = start; end < units.length && end < start + merged.maxBundles; end += 1) {
      const sourceTokenCount = units.slice(start, end + 1).reduce((sum, unit) => sum + unit.sourceTokenCount, 0);
      if (end > start && sourceTokenCount > merged.hardMaxTokens) break;
      candidates.push(makeCandidate(messages, units, start, end, merged, merged.projectInputTokens));
    }
  }
  return Object.freeze(candidates);
}

export function optimizeAdaptiveSegments(messages, options = {}) {
  const merged = { ...DEFAULT_ADAPTIVE_PLANNER_OPTIONS, ...options };
  const candidates = enumerateAdaptiveCandidates(messages, merged);
  const units = turnUnits(messages);
  const byStart = new Map();
  for (const candidate of candidates) {
    if (!candidate.safe) continue;
    if (!byStart.has(candidate.unitStart)) byStart.set(candidate.unitStart, []);
    byStart.get(candidate.unitStart).push(candidate);
  }
  const states = Array.from({ length: units.length + 1 }, () => []);
  states[0] = [{ segments: [], metrics: { expectedAttempts: 0, expectedRequests: 0, expectedInputTokens: 0, expectedOutputTokens: 0, expectedTotalTokens: 0, expectedWallTimeMs: 0, maxInputTokens: 0, boundaryScore: 0, uniformityPenalty: 0 } }];
  for (let cursor = 0; cursor < units.length; cursor += 1) {
    if (!states[cursor].length) continue;
    for (const path of states[cursor]) {
      for (const candidate of byStart.get(cursor) ?? []) {
        const next = combinePlan(path, candidate);
        states[candidate.unitEnd + 1].push(next);
        states[candidate.unitEnd + 1] = pruneFrontier(states[candidate.unitEnd + 1], merged.frontierLimit ?? 256);
      }
    }
  }
  const paths = states[units.length];
  if (!paths.length) throw new RangeError('No safe adaptive segment plan exists');
  const economic = objectivePlan(paths, 'economic');
  const nearOptimal = paths.filter(path => path.metrics.expectedTotalTokens <= economic.metrics.expectedTotalTokens * merged.nearOptimalRatio);
  const balanced = objectivePlan(nearOptimal.length ? nearOptimal : paths, 'fast');
  const fast = objectivePlan(paths, 'fast');
  const safeBudget = economic.metrics.expectedTotalTokens * merged.safeOverheadRatio;
  const safeCandidates = paths.filter(path => path.metrics.expectedTotalTokens <= safeBudget);
  const safe = safeCandidates.sort((left, right) => left.metrics.maxInputTokens - right.metrics.maxInputTokens || comparePlans(left, right, 'economic'))[0] ?? economic;
  const plans = [
    decoratePlan(economic, 'economic', merged),
    decoratePlan(fast, 'fast', merged),
    decoratePlan(safe, 'safe', merged),
    decoratePlan(balanced, 'balanced', merged),
  ];
  const unique = new Map(plans.filter(Boolean).map(plan => [plan.id, plan]));
  const recommended = unique.get(plans.find(plan => plan?.objective === 'balanced')?.id) ?? plans[0];
  return Object.freeze({
    plannerVersion: ADAPTIVE_PLANNER_VERSION,
    recommended,
    alternatives: Object.freeze([...unique.values()]),
    candidates: Object.freeze(candidates),
    bundleCount: units.length,
    sourceTokenCount: units.reduce((sum, unit) => sum + unit.sourceTokenCount, 0),
    safetyCeiling: Math.max(1, Math.floor(merged.inputBudget * merged.safetyRatio)),
  });
}

export function combineAdaptivePlans(plans = [], { objective = 'balanced', calibrationConfidence = 'low' } = {}) {
  const usable = plans.filter(Boolean);
  if (!usable.length) return null;
  const segments = usable.flatMap(plan => plan.segments ?? []).sort((left, right) => left.firstIndex - right.firstIndex);
  const metrics = segments.reduce((sum, segment) => ({
    expectedAttempts: sum.expectedAttempts + (segment.expectedAttempts ?? 1),
    expectedRequests: sum.expectedRequests + (segment.expectedRequests ?? segment.expectedAttempts ?? 1),
    expectedInputTokens: sum.expectedInputTokens + (segment.cost?.expectedInputTokens ?? segment.projectedInputTokens ?? 0),
    expectedOutputTokens: sum.expectedOutputTokens + (segment.cost?.expectedOutputTokens ?? segment.expectedOutputTokens ?? 0),
    expectedTotalTokens: sum.expectedTotalTokens + (segment.cost?.expectedTotalTokens ?? (segment.projectedInputTokens ?? 0) + (segment.expectedOutputTokens ?? 0)),
    expectedWallTimeMs: sum.expectedWallTimeMs + (segment.expectedWallTimeMs ?? 0),
    maxInputTokens: Math.max(sum.maxInputTokens, segment.projectedInputTokens ?? 0),
    boundaryScore: sum.boundaryScore,
    uniformityPenalty: uniformityPenalty(segments.map(value => value.projectedInputTokens ?? 0)),
  }), { expectedAttempts: 0, expectedRequests: 0, expectedInputTokens: 0, expectedOutputTokens: 0, expectedTotalTokens: 0, expectedWallTimeMs: 0, maxInputTokens: 0, boundaryScore: 0 });
  return { id: fingerprintValue({ objective, segments: segments.map(segment => segment.id) }, 'adaptive-plan'), objective, plannerVersion: ADAPTIVE_PLANNER_VERSION, segments, metrics: { ...metrics, calibrationConfidence } };
}

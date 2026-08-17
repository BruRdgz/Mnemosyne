import { createSourceRange } from '../domain/fingerprint.js';
import { segmentIdFromSource } from '../domain/ids.js';
import { createTurnBundles, turnBundleFingerprint } from '../domain/turn-bundle.js';

export const DEFAULT_SEGMENT_BUDGETS = Object.freeze({
  targetTokens: 5_000,
  softMaxTokens: 7_000,
  hardMaxTokens: 9_000,
  preemptiveRatio: 0.85,
});

const BOUNDARY_WEIGHTS = Object.freeze({ chapter: 4, scene: 3, time: 2, location: 1 });

function validateBudgets({ targetTokens, softMaxTokens, hardMaxTokens }) {
  if (![targetTokens, softMaxTokens, hardMaxTokens].every(value => Number.isInteger(value) && value > 0)) {
    throw new TypeError('Segment budgets must be positive integers');
  }
  if (!(targetTokens <= softMaxTokens && softMaxTokens <= hardMaxTokens)) {
    throw new RangeError('Segment budgets must satisfy target <= soft <= hard');
  }
}

function messageRole(message) {
  return message.role ?? (message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'));
}

function pairFriendly(messages, endPosition) {
  const current = messages[endPosition];
  const next = messages[endPosition + 1];
  return messageRole(current) === 'assistant' && (!next || messageRole(next) === 'user');
}

function boundaryWeight(message) {
  const hint = message.boundaryHint;
  if (typeof hint === 'string') return BOUNDARY_WEIGHTS[hint] ?? 0;
  if (Array.isArray(hint)) return Math.max(0, ...hint.map(value => BOUNDARY_WEIGHTS[value] ?? 0));
  return 0;
}

function checkedTokens(message, position) {
  if (!Number.isInteger(message.tokenCount) || message.tokenCount < 0) {
    throw new TypeError(`Message at position ${position} lacks a non-negative integer tokenCount`);
  }
  return message.tokenCount;
}

export function planSegments(messages, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  const budgets = { ...DEFAULT_SEGMENT_BUDGETS, ...options };
  validateBudgets(budgets);
  if (options.atomicTurns) return planAtomicTurns(messages, budgets, options.metrics ?? null);
  const metrics = options.metrics ?? null;
  const planned = [];
  let start = 0;

  while (start < messages.length) {
    const firstTokens = checkedTokens(messages[start], start);
    if (firstTokens > budgets.hardMaxTokens) {
      planned.push(makeSegment(messages, start, start, firstTokens, 'oversized_message', true));
      start += 1;
      continue;
    }

    const candidates = [];
    let total = 0;
    for (let end = start; end < messages.length; end += 1) {
      const nextTotal = total + checkedTokens(messages[end], end);
      if (nextTotal > budgets.hardMaxTokens) break;
      total = nextTotal;
      candidates.push({
        end,
        total,
        natural: boundaryWeight(messages[end]),
        pair: pairFriendly(messages, end) ? 1 : 0,
        final: end === messages.length - 1,
      });
    }

    if (candidates.length === 0) throw new Error('Segment planner made no progress');
    const minimumUseful = Math.floor(budgets.targetTokens * 0.7);
    const useful = candidates.filter(candidate => candidate.final || candidate.total >= minimumUseful);
    const pool = useful.length ? useful : candidates;
    pool.sort((left, right) => compareCandidates(left, right, budgets));
    const choice = pool[0];
    const reason = choice.final
      ? 'history_end'
      : choice.natural > 0
        ? 'natural_boundary'
        : choice.pair
          ? 'pair_boundary'
          : choice.total > budgets.softMaxTokens
            ? 'hard_limit'
            : 'target_proximity';
    planned.push(makeSegment(messages, start, choice.end, choice.total, reason, false));
    start = choice.end + 1;
  }

  const coverage = validateSegmentCoverage(planned, messages.map((message, position) => message.index ?? position));
  if (!coverage.ok) throw new Error(`Invalid segment coverage: ${coverage.errors.join('; ')}`);
  metrics?.record({
    operation: 'segment_plan',
    sourceMessageCount: messages.length,
    segmentCount: planned.length,
    sourceTokenCount: planned.reduce((sum, segment) => sum + segment.sourceTokenCount, 0),
    oversizedCount: planned.filter(segment => segment.oversized).length,
    status: 'success',
  });
  return Object.freeze(planned);
}

function turnUnits(messages) {
  const positions = new Map(messages.map((message, position) => [message.index ?? position, position]));
  return createTurnBundles(messages).map(bundle => {
    const start = positions.get(bundle.firstIndex);
    const end = positions.get(bundle.lastIndex);
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('Turn bundle does not map to source positions');
    return {
      start,
      end,
      total: messages.slice(start, end + 1).reduce((sum, message, offset) => sum + checkedTokens(message, start + offset), 0),
      complete: bundle.complete,
      kind: bundle.kind,
    };
  });
}

function planAtomicTurns(messages, budgets, metrics) {
  const units = turnUnits(messages);
  const planned = [];
  let cursor = 0;
  while (cursor < units.length) {
    const first = units[cursor];
    if (first.total > budgets.hardMaxTokens) {
      planned.push(makeSegment(messages, first.start, first.end, first.total, 'oversized_turn', true));
      cursor += 1;
      continue;
    }
    const candidates = [];
    let total = 0;
    for (let endUnit = cursor; endUnit < units.length; endUnit += 1) {
      const nextTotal = total + units[endUnit].total;
      if (nextTotal > budgets.hardMaxTokens) break;
      total = nextTotal;
      candidates.push({
        endUnit,
        end: units[endUnit].end,
        total,
        natural: boundaryWeight(messages[units[endUnit].end]),
        pair: 1,
        final: endUnit === units.length - 1,
      });
    }
    if (!candidates.length) throw new Error('Atomic-turn planner made no progress');
    const minimumUseful = Math.floor(budgets.targetTokens * 0.7);
    const useful = candidates.filter(candidate => candidate.final || candidate.total >= minimumUseful);
    const pool = useful.length ? useful : candidates;
    pool.sort((left, right) => compareCandidates(left, right, budgets));
    const choice = pool[0];
    const reason = choice.final
      ? 'history_end'
      : choice.natural > 0
        ? 'natural_boundary'
        : choice.total > budgets.softMaxTokens
          ? 'hard_limit'
          : 'turn_batch';
    planned.push(makeSegment(messages, first.start, choice.end, choice.total, reason, false));
    cursor = choice.endUnit + 1;
  }
  const coverage = validateSegmentCoverage(planned, messages.map((message, position) => message.index ?? position));
  if (!coverage.ok) throw new Error(`Invalid atomic-turn coverage: ${coverage.errors.join('; ')}`);
  metrics?.record({ operation: 'segment_plan', sourceMessageCount: messages.length, segmentCount: planned.length, sourceTokenCount: planned.reduce((sum, segment) => sum + segment.sourceTokenCount, 0), oversizedCount: planned.filter(segment => segment.oversized).length, atomicTurns: true, status: 'success' });
  return Object.freeze(planned);
}

function compareCandidates(left, right, budgets) {
  const score = candidate => {
    const overSoftPenalty = candidate.total > budgets.softMaxTokens ? 100 : 0;
    const distancePenalty = Math.abs(candidate.total - budgets.targetTokens) / budgets.targetTokens;
    return candidate.natural * 10 + candidate.pair * 3 + (candidate.final ? 2 : 0) - overSoftPenalty - distancePenalty;
  };
  return score(right) - score(left) || left.end - right.end;
}

export function makeSegment(messages, start, end, sourceTokenCount, boundaryReason, oversized) {
  const slice = messages.slice(start, end + 1);
  const firstIndex = slice[0].index ?? start;
  const lastIndex = slice.at(-1).index ?? end;
  const range = createSourceRange(slice, firstIndex);
  const turnBundles = createTurnBundles(slice);
  const source = Object.freeze({ ...range, turnBundles, turnBundleFingerprint: turnBundleFingerprint(turnBundles) });
  return Object.freeze({
    id: segmentIdFromSource(source.rangeFingerprint),
    firstIndex,
    lastIndex,
    source,
    sourceTokenCount,
    boundaryReason,
    oversized,
  });
}

export function validateSegmentCoverage(segments, expectedIndices) {
  const errors = [];
  const covered = [];
  for (const segment of segments) {
    for (let index = segment.firstIndex; index <= segment.lastIndex; index += 1) covered.push(index);
  }
  const duplicates = covered.filter((value, index) => covered.indexOf(value) !== index);
  if (duplicates.length) errors.push(`duplicate indices: ${[...new Set(duplicates)].join(',')}`);
  const expected = [...expectedIndices];
  const missing = expected.filter(index => !covered.includes(index));
  const unexpected = covered.filter(index => !expected.includes(index));
  if (missing.length) errors.push(`missing indices: ${missing.join(',')}`);
  if (unexpected.length) errors.push(`unexpected indices: ${unexpected.join(',')}`);
  return { ok: errors.length === 0, errors, covered };
}

export function computeCompactionFrontier(messages, rawForeground, options = {}) {
  const preemptiveRatio = options.preemptiveRatio ?? DEFAULT_SEGMENT_BUDGETS.preemptiveRatio;
  if (!(preemptiveRatio > 0 && preemptiveRatio <= 1)) throw new RangeError('preemptiveRatio must be in (0, 1]');
  const eligibleThroughIndex = rawForeground.firstIndex === null
    ? (messages.at(-1)?.index ?? messages.length - 1)
    : rawForeground.firstIndex - 1;
  const eligible = messages.filter((message, position) => (message.index ?? position) <= eligibleThroughIndex);
  const utilization = rawForeground.budgetTokens > 0 ? rawForeground.totalTokens / rawForeground.budgetTokens : 0;
  return Object.freeze({
    eligibleThroughIndex,
    eligibleMessageCount: eligible.length,
    eligibleTokenCount: eligible.reduce((sum, message, position) => sum + checkedTokens(message, position), 0),
    rawUtilization: utilization,
    shouldSchedule: eligible.length > 0 && utilization >= preemptiveRatio,
  });
}

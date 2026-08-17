import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';
import { planRawForeground } from '../../src/planning/raw-foreground.js';
import {
  computeCompactionFrontier, DEFAULT_SEGMENT_BUDGETS, planSegments, validateSegmentCoverage,
} from '../../src/planning/segment-planner.js';

const msg = (index, role, tokenCount, boundaryHint) => ({ index, role, tokenCount, text: `m${index}`, swipeId: 0, boundaryHint });

test('Phase 3: default target/soft/hard budgets are ordered', () => {
  assert.deepEqual(DEFAULT_SEGMENT_BUDGETS, {
    targetTokens: 5_000, softMaxTokens: 7_000, hardMaxTokens: 9_000, preemptiveRatio: 0.85,
  });
  assert.throws(() => planSegments([msg(0, 'user', 1)], { targetTokens: 10, softMaxTokens: 5, hardMaxTokens: 20 }), /target <= soft <= hard/);
});

test('Phase 3: boundaries are deterministic and messages remain atomic', () => {
  const input = Array.from({ length: 8 }, (_, index) => msg(index, index % 2 ? 'assistant' : 'user', 3));
  const options = { targetTokens: 8, softMaxTokens: 10, hardMaxTokens: 12 };
  const first = planSegments(input, options);
  const second = planSegments(structuredClone(input), options);
  assert.deepEqual(first.map(segment => [segment.firstIndex, segment.lastIndex]), second.map(segment => [segment.firstIndex, segment.lastIndex]));
  assert.equal(first.reduce((sum, segment) => sum + segment.sourceTokenCount, 0), 24);
});

test('Phase 3: complete user/assistant pair boundary wins near target', () => {
  const input = [msg(0, 'user', 2), msg(1, 'assistant', 2), msg(2, 'user', 2), msg(3, 'assistant', 2), msg(4, 'user', 2)];
  const planned = planSegments(input, { targetTokens: 7, softMaxTokens: 9, hardMaxTokens: 10 });
  assert.equal(planned[0].lastIndex, 3);
  assert.equal(planned[0].boundaryReason, 'pair_boundary');
});

test('Phase 3: natural scene/chapter boundary can beat slightly closer token boundary', () => {
  const input = [
    msg(0, 'user', 2), msg(1, 'assistant', 2),
    msg(2, 'user', 2), msg(3, 'assistant', 2, 'chapter'),
    msg(4, 'user', 2), msg(5, 'assistant', 2),
  ];
  const planned = planSegments(input, { targetTokens: 10, softMaxTokens: 12, hardMaxTokens: 14 });
  assert.equal(planned[0].lastIndex, 3);
  assert.equal(planned[0].boundaryReason, 'natural_boundary');
});

test('Phase 3: no source gap or duplicate coverage across planned ranges', () => {
  const input = Array.from({ length: 37 }, (_, index) => msg(index, index % 2 ? 'assistant' : 'user', (index % 4) + 1));
  const planned = planSegments(input, { targetTokens: 13, softMaxTokens: 17, hardMaxTokens: 20 });
  const coverage = validateSegmentCoverage(planned, input.map(message => message.index));
  assert.equal(coverage.ok, true, coverage.errors.join('\n'));
  assert.deepEqual(coverage.covered, input.map(message => message.index));
});

test('Phase 3: one message beyond hard max becomes one explicit oversized segment', () => {
  const planned = planSegments([msg(0, 'user', 99), msg(1, 'assistant', 2)], { targetTokens: 5, softMaxTokens: 7, hardMaxTokens: 9 });
  assert.equal(planned[0].oversized, true);
  assert.equal(planned[0].boundaryReason, 'oversized_message');
  assert.deepEqual([planned[0].firstIndex, planned[0].lastIndex], [0, 0]);
});

test('Phase 3: compaction frontier stops immediately before the raw foreground', () => {
  const input = Array.from({ length: 10 }, (_, index) => msg(index, index % 2 ? 'assistant' : 'user', 2));
  const raw = planRawForeground(input, { budgetTokens: 9 });
  const frontier = computeCompactionFrontier(input, raw, { preemptiveRatio: 0.8 });
  assert.equal(frontier.eligibleThroughIndex, raw.firstIndex - 1);
  assert.equal(frontier.eligibleMessageCount, raw.firstIndex);
  assert.equal(frontier.shouldSchedule, true);
});

test('Phase 3: preemptive scheduling stays off below utilization threshold', () => {
  const input = [msg(0, 'user', 2), msg(1, 'assistant', 2), msg(2, 'user', 2)];
  const raw = planRawForeground(input, { budgetTokens: 100 });
  const frontier = computeCompactionFrontier(input, raw, { preemptiveRatio: 0.85 });
  assert.equal(frontier.shouldSchedule, false);
});

test('Phase 3: planning metrics expose counts and sizes without narrative prose', () => {
  const metrics = new MetricsRecorder();
  planSegments([msg(0, 'user', 2), msg(1, 'assistant', 2)], { targetTokens: 3, softMaxTokens: 4, hardMaxTokens: 5, metrics });
  const json = JSON.stringify(metrics.snapshot());
  assert.match(json, /segmentCount/);
  assert.doesNotMatch(json, /m0|m1/);
});

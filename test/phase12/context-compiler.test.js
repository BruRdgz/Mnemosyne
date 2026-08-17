import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompiler, applyPromptVirtualization } from '../../src/context/context-compiler.js';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';
import { projectNarrativeState } from '../../src/state/state-projector.js';

const countTokens = async text => String(text).trim() ? String(text).trim().split(/\s+/).length : 0;
const memory = (id, first, last, synopsis, status = 'valid') => ({ id, status, source: { first: { messageIndex: first }, last: { messageIndex: last } }, summary: { synopsis } });

test('Phase 12: valid selected segment is omitted while failed/stale sources remain raw', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const compiled = await compiler.compile({
    chronological: [memory('valid', 0, 1, 'A valid compact episode.'), memory('failed', 2, 2, 'Must not appear.', 'failed'), memory('stale', 3, 3, 'Must not appear.', 'stale')],
    rawMessages: [{ index: 2, role: 'assistant', text: 'failed source raw' }, { index: 3, role: 'assistant', text: 'stale source raw' }, { index: 4, role: 'user', text: 'current turn', required: true }],
  }, { hardTotal: 100, raw: 50, chronological: 50 });
  assert.deepEqual(compiled.omitIndices, [0, 1]);
  assert.doesNotMatch(compiled.block, /Must not appear/);
  assert.equal(compiled.omitIndices.includes(2), false);
  assert.equal(compiled.omitIndices.includes(3), false);
});

test('Phase 12: a summary is not injected when any of its source is in raw foreground', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const compiled = await compiler.compile({ chronological: [memory('overlap', 2, 4, 'Duplicate summary')], rawMessages: [{ index: 4, role: 'user', text: 'source remains raw', required: true }] }, { hardTotal: 100, raw: 50, chronological: 50 });
  assert.doesNotMatch(compiled.block, /Duplicate summary/);
  assert.deepEqual(compiled.omitIndices, []);
  assert.equal(compiled.dropped.deduplicated, 1);
});

test('Phase 12: region and hard budgets pack critical state before weak inference', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const compiled = await compiler.compile({
    state: [{ id: 'critical', text: 'critical injury needs medicine now', evidence: 'explicit' }, { id: 'weak', text: 'perhaps maybe possibly secretly likes decorative clouds', evidence: 'weak_inference' }],
    rawMessages: [{ index: 9, role: 'user', text: 'Help her now', required: true }],
  }, { hardTotal: 80, raw: 10, state: 10, registers: 0, chronological: 0, associative: 0 });
  assert.equal(compiled.overflow, false);
  assert.ok(compiled.totalTokens <= 80);
  assert.match(compiled.block, /critical injury/);
  assert.doesNotMatch(compiled.block, /decorative clouds/);
});

test('Phase 12: oversized raw request leaves a semantic reserve in a 6k managed context', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const compiled = await compiler.compile({
    state: ['The active commitment is to answer Jean first.'],
    chronological: [memory('recent', 0, 1, 'The recent exchange established the next scene.')],
    associative: [memory('older', 2, 3, 'An older callback remains relevant.')],
    rawMessages: [{ index: 4, role: 'user', text: 'Continue the scene.', required: true }],
  }, { hardTotal: 6_000, raw: 8_000, state: 800, registers: 300, chronological: 2_500, associative: 1_500 });
  assert.equal(compiled.budgets.raw, 3_600);
  assert.match(compiled.block, /active commitment/);
  assert.match(compiled.block, /recent exchange/);
  assert.match(compiled.block, /older callback/);
});

test('Phase 12: active registers and all configured regions have exact token accounting', async () => {
  const metrics = new MetricsRecorder();
  const compiler = new ContextCompiler({ countTokens, metrics });
  const compiled = await compiler.compile({
    state: ['Peter is injured.'], registers: [{ id: 'score', status: 'active', text: 'Score Peter 2 Mary 1' }],
    chronological: [memory('recent', 0, 1, 'They entered the final.')],
    associative: [{ ...memory('old', 2, 3, 'Peter once hid the key.'), score: 4 }],
    rawMessages: [{ index: 10, role: 'user', text: 'Who has the key?', required: true }],
  }, { hardTotal: 100, state: 20, registers: 20, chronological: 20, associative: 20, raw: 20 });
  assert.match(compiled.block, /ACTIVE TRACKED REGISTERS/);
  assert.equal(compiled.totalTokens, await countTokens(compiled.block) + compiled.regionTokens.raw);
  const metric = metrics.snapshot().find(event => event.operation === 'context_compile');
  assert.deepEqual([metric.stateTokens, metric.registerTokens, metric.recentTokens, metric.associativeTokens, metric.rawForegroundTokens], [compiled.regionTokens.state, compiled.regionTokens.registers, compiled.regionTokens.chronological, compiled.regionTokens.associative, compiled.regionTokens.raw]);
});

test('Phase 12: prompt virtualization is ephemeral and preview equals actual injection', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const compiled = await compiler.compile({ chronological: [memory('old', 0, 0, 'Old truth survives.')], rawMessages: [{ index: 1, role: 'user', text: 'Continue', required: true }] }, { hardTotal: 100, raw: 30, chronological: 30 });
  const sourceChat = [{ mes: 'old raw truth' }, { mes: 'Continue', is_user: true }];
  const generationChat = [...sourceChat];
  let injected = '';
  const virtualized = applyPromptVirtualization(generationChat, compiled, { ignoreSymbol: Symbol.for('ignore'), setInjection: value => { injected = value; } });
  assert.equal(sourceChat[0].mes, 'old raw truth');
  assert.equal(generationChat[0].mes, 'old raw truth');
  assert.equal(generationChat[0].extra[Symbol.for('ignore')], true);
  assert.equal(virtualized.preview, compiled.preview);
  assert.equal(injected, compiled.preview);
});

test('Phase 12: stable prefix fingerprint changes only when stable regions change', async () => {
  const compiler = new ContextCompiler({ countTokens });
  const base = { state: ['Door is locked.'], rawMessages: [{ index: 4, role: 'user', text: 'First', required: true }] };
  const first = await compiler.compile(base, { hardTotal: 100, raw: 30, state: 30 });
  const second = await compiler.compile({ ...base, rawMessages: [{ index: 5, role: 'user', text: 'Second', required: true }] }, { hardTotal: 100, raw: 30, state: 30 });
  const third = await compiler.compile({ ...base, state: ['Door is open.'] }, { hardTotal: 100, raw: 30, state: 30 });
  assert.equal(first.stablePrefixChanged, true);
  assert.equal(second.stablePrefixChanged, false);
  assert.equal(third.stablePrefixChanged, true);
});

test('Phase 12: critical-path metric excludes deferred extraction latency', async () => {
  const metrics = new MetricsRecorder();
  const compiler = new ContextCompiler({ countTokens, metrics });
  await compiler.compile({ rawMessages: [{ index: 0, role: 'user', text: 'Continue', required: true }] }, { hardTotal: 50, raw: 20 });
  metrics.record({ operation: 'segment_extraction', durationMs: 9_999, status: 'success' });
  const contextMetric = metrics.snapshot().find(event => event.operation === 'context_compile');
  assert.ok(contextMetric.durationMs < 9_999);
  assert.equal(Object.hasOwn(contextMetric, 'segmentExtractionMs'), false);
});

test('Phase 12: projected state is atomic so active commitments survive oversized low-priority noise', async () => {
  const state = {
    characters: {}, relationships: {}, worldFacts: {}, narratorFacts: {},
    commitments: { notice: { id: 'notice', actor: 'Edward', content: 'Give notice before missions', status: 'active', evidence: 'explicit' } },
    threads: {},
    salientNegatives: [{ key: 'noise', proposition: Array(120).fill('irrelevant').join(' '), reason: 'explicit', evidence: 'explicit' }],
  };
  const items = projectNarrativeState(state);
  assert.equal(items[0].id, 'state:commitment:notice');
  const compiler = new ContextCompiler({ countTokens });
  const compiled = await compiler.compile({ state: items }, { hardTotal: 60, state: 30, raw: 0, chronological: 0, associative: 0, registers: 0 });
  assert.match(compiled.block, /Give notice before missions/);
  assert.doesNotMatch(compiled.block, /irrelevant irrelevant irrelevant/);
});

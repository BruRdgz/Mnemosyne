import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createPortableEnvelope } from '../../src/storage/semantic-store.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { calculateCredits } from '../../src/observability/credit-accounting.js';
import { planSegments } from '../../src/planning/segment-planner.js';
import { normalizeReplayArtifact } from '../../src/rebuild/replay-generation.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

function history(count = 14) {
  return Array.from({ length: count }, (_, index) => ({
    is_user: index % 2 === 0,
    is_system: false,
    name: index % 2 ? 'Character' : 'User',
    mes: `message ${index}`,
    swipe_id: 0,
  }));
}

async function fixture(generateRaw, { localforage = createMemoryLocalForage(), metadata = null, settings = {} } = {}) {
  const chat = history();
  const fake = createFakeContext({
    chat,
    chatMetadata: { mnemosyne: metadata ?? createPortableEnvelope('fixture-chat') },
    generateRaw,
  });
  const runtimeSettings = { rawTailBudget: 4, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, memoryCooldownMs: 0, ...settings };
  const extensionSettings = { mnemosyne: runtimeSettings };
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings,
    localforage,
  });
  return { chat, fake, runtime, localforage, settings: extensionSettings.mnemosyne };
}

test('Blue/green rebuild persists green attempts, blocks its suffix, and resumes the exact failed range', async () => {
  let calls = 0;
  let quotaAtThree = true;
  let running;
  const localforage = createMemoryLocalForage();
  running = await fixture(async () => {
    calls += 1;
    if (calls > 1) {
      const firstSession = running.fake.context.chatMetadata.mnemosyne.rebuildSessions[0];
      assert.equal(firstSession.attempts.length, calls - 1, 'attempt metadata must exist before the next request');
      assert.ok(await localforage.instances[0].getItem(firstSession.attempts.at(-1).rawOutputRef), 'raw response must exist before the next request');
    }
    if (quotaAtThree && calls === 3) throw Object.assign(new Error('Payment Required'), { code: 'quota', status: 402, providerBody: { error: 'credits' } });
    const summary = emptyEpisodeSummary(`Candidate ${calls}.`);
    return {
      id: `request-${calls}`,
      model: 'glm-5.2',
      content: JSON.stringify(summary),
      choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } },
    };
  }, { localforage });
  const sourceBefore = structuredClone(running.chat);
  const session = await running.runtime.narrative.startRebuild();
  const rangeCount = session.plan.length;
  const stopped = await running.runtime.narrative.resumeRebuild(session.id);

  assert.equal(stopped.status, 'stopped-on-failure');
  assert.deepEqual(stopped.session.plan.map(item => item.status), ['valid', 'valid', 'failed', ...Array(rangeCount - 3).fill('pending')]);
  assert.equal(running.runtime.narrative.snapshot().segments.length, 0, 'active green baseline must not change while incomplete');
  assert.deepEqual(running.chat, sourceBefore);
  const exported = JSON.parse(await running.runtime.narrative.exportRebuildSession(session.id));
  assert.equal(exported.rawAttempts.length, 3);
  assert.equal(exported.rawAttempts[0].value.rawResponse.id, 'request-1');
  assert.equal(exported.rawAttempts[2].value.error.providerBody.error, 'credits');

  quotaAtThree = false;
  const completed = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(calls, rangeCount + 1, 'the two already-green ranges must not be requested again');
  assert.equal(completed.session.plan.every(item => item.status === 'valid'), true);
  assert.equal(running.runtime.narrative.snapshot().segments.length, 0, 'completion is still blue until explicit promotion');

  await running.runtime.narrative.promoteRebuild(session.id);
  assert.equal(running.runtime.narrative.snapshot().segments.length, rangeCount);
  assert.deepEqual(running.chat, sourceBefore);
  running.runtime.dispose();
});

test('Truncated output is retained and the same atomic turn is retried', async () => {
  let calls = 0;
  const running = await fixture(async () => {
    calls += 1;
    return {
      id: `request-${calls}`,
      content: JSON.stringify(emptyEpisodeSummary(`Output ${calls}.`)),
      choices: [{ finish_reason: calls === 1 ? 'length' : 'stop' }],
    };
  });
  const session = await running.runtime.narrative.startRebuild();
  const rangeCount = session.plan.length;
  const stopped = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(stopped.session.plan[0].status, 'failed');
  assert.equal(stopped.session.attempts[0].finishReason, 'length');
  assert.equal(stopped.session.segments[0].extraction.failure, 'truncated');
  const completed = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(calls, rangeCount + 1);
  assert.equal(completed.session.attempts.filter(attempt => attempt.segmentId === completed.session.plan[0].segmentId).length, 2);
  running.runtime.dispose();
});

test('EOF-truncated JSON without finish_reason is retained and resumed with the compact output cap', async () => {
  let calls = 0;
  const requests = [];
  const running = await fixture(async request => {
    calls += 1;
    requests.push(request);
    return calls === 1 ? '{"synopsis":"unfinished' : JSON.stringify(emptyEpisodeSummary(`Recovered ${calls}.`));
  });
  const session = await running.runtime.narrative.startRebuild();
  const stopped = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(stopped.session.plan[0].status, 'failed');
  assert.equal(stopped.session.segments[0].extraction.failure, 'truncated');
  assert.equal(stopped.session.attempts[0].finishReason, null);
  assert.equal(stopped.analysis.compactRetry.maxOutputTokens, 2_500);
  assert.equal(stopped.analysis.compactRetry.credits.noCache > 0, true);
  const completed = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(requests[1].responseLength, 2_500, 'the explicit retry must use the compact output ceiling');
  assert.equal(completed.session.attempts[1].protocol, 'truncation_compact_v1');
  running.runtime.dispose();
});

test('A compact truncation escalates once to the minimal tagged fallback instead of repeating the same cap', async () => {
  let calls = 0;
  const requests = [];
  const running = await fixture(async request => {
    calls += 1;
    requests.push(request);
    if (calls === 1) return '{"synopsis":"unfinished';
    if (calls === 2) {
      return {
        id: 'request-compact-truncated',
        content: '{"synopsis":"still unfinished',
        choices: [{ finish_reason: 'length' }],
      };
    }
    if (calls === 3) return '[SYNOPSIS]\nRecovered with the minimal fallback.';
    return JSON.stringify(emptyEpisodeSummary(`Recovered ${calls}.`));
  });
  const session = await running.runtime.narrative.startRebuild();
  const firstStop = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(firstStop.status, 'stopped-on-failure');
  const compactStop = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(compactStop.status, 'stopped-on-failure');
  assert.equal(compactStop.session.attempts[1].protocol, 'truncation_compact_v1');
  assert.equal(compactStop.session.attempts[1].finishReason, 'length');
  assert.equal(compactStop.analysis.compactRetry.stage, 'tight_fallback');
  assert.equal(compactStop.analysis.compactRetry.maxOutputTokens, 1_200);
  assert.equal(compactStop.analysis.compactRetry.protocol, 'minimal_fallback_tight_v3');

  const completed = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(requests[1].responseLength, 2_500, 'the first retry remains the compact structured request');
  assert.ok(requests[1].jsonSchema, 'the compact retry still requests structured JSON');
  assert.equal(requests[2].responseLength, 1_200, 'the escalation uses the tight fallback ceiling');
  assert.equal(requests[2].jsonSchema, null, 'the fallback does not send the provider schema');
  assert.equal(completed.session.attempts[2].protocol, 'minimal_fallback_tight_v3');
  assert.equal(completed.session.attempts[2].mode, 'fallback');
  assert.equal(completed.session.attempts[2].status, 'valid');
  assert.equal(completed.session.segments[0].extraction.format, 'fallback');
  assert.equal(completed.session.segments[0].summary.synopsis, 'Recovered with the minimal fallback.');
  running.runtime.dispose();
});

test('Invalid JSON remains exportable and blocks later turns until replacement succeeds', async () => {
  let calls = 0;
  const running = await fixture(async () => {
    calls += 1;
    return calls === 1 ? '{"broken": }' : JSON.stringify(emptyEpisodeSummary(`Valid ${calls}.`));
  });
  const session = await running.runtime.narrative.startRebuild();
  const stopped = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(stopped.session.segments[0].extraction.failure, 'invalid_json');
  assert.equal(stopped.session.plan[1].status, 'pending');
  const exported = JSON.parse(await running.runtime.narrative.exportRebuildSession(session.id));
  assert.equal(exported.rawAttempts[0].value.text, '{"broken": }');
  assert.equal(exported.rawAttempts[0].value.rawResponse, '{"broken": }');
  const completed = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(calls, session.plan.length + 1);
  running.runtime.dispose();
});

test('Source edits archive the dependent candidate suffix without deleting attempts', async () => {
  let calls = 0;
  const running = await fixture(async () => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('Payment Required'), { code: 'quota' });
    return JSON.stringify(emptyEpisodeSummary('Candidate.'));
  });
  const session = await running.runtime.narrative.startRebuild();
  await running.runtime.narrative.resumeRebuild(session.id);
  running.fake.context.chat[0].mes = 'edited source';
  await assert.rejects(() => running.runtime.narrative.resumeRebuild(session.id), /archived/);
  const archived = running.runtime.narrative.getRebuildSession(session.id);
  assert.equal(archived.archiveReason, 'source_changed');
  assert.equal(archived.plan.every(item => item.status === 'stale'), true);
  assert.equal(archived.attempts.length, 2);
  running.runtime.dispose();
});

test('Envelope v1 migrates locally without model calls or active-memory loss', async () => {
  let calls = 0;
  const legacy = createPortableEnvelope('fixture-chat');
  delete legacy.envelopeVersion;
  delete legacy.rebuildSessions;
  legacy.conflicts.push({ id: 'preserved' });
  const running = await fixture(async () => { calls += 1; return '{}'; }, { metadata: legacy });
  const snapshot = running.runtime.narrative.snapshot();
  assert.equal(snapshot.envelopeVersion, 2);
  assert.deepEqual(snapshot.rebuildSessions, []);
  assert.deepEqual(snapshot.conflicts, [{ id: 'preserved' }]);
  assert.equal(calls, 0);
  running.runtime.dispose();
});

test('Atomic-turn planning never separates a user message from its following assistant response', () => {
  const messages = [
    { index: 0, role: 'user', text: 'u0', tokenCount: 6_000, original: {} },
    { index: 1, role: 'assistant', text: 'a1', tokenCount: 6_000, original: {} },
    { index: 2, role: 'user', text: 'u2', tokenCount: 1_000, original: {} },
    { index: 3, role: 'assistant', text: 'a3', tokenCount: 1_000, original: {} },
  ];
  const plan = planSegments(messages, { targetTokens: 5_000, softMaxTokens: 7_000, hardMaxTokens: 9_000, atomicTurns: true });
  assert.deepEqual(plan.map(item => [item.firstIndex, item.lastIndex]), [[0, 1], [2, 3]]);
  assert.equal(plan[0].oversized, true);
  assert.equal(plan[0].boundaryReason, 'oversized_turn');
});

test('Credit accounting keeps cached, uncached, and output multipliers distinct', () => {
  assert.equal(calculateCredits(
    { nominalInputTokens: 1_000, cachedInputTokens: 200, uncachedInputTokens: 800, outputTokens: 300 },
    { inputMultiplier: 0.5, outputMultiplier: 0.7, cacheMultiplier: 0.1 },
  ), 630);
});

test('Replay rebuild consumes recorded responses without invoking a provider and records zero new credits', async () => {
  let liveCalls = 0;
  const live = await fixture(async () => {
    liveCalls += 1;
    return JSON.stringify(emptyEpisodeSummary(`Paid candidate ${liveCalls}.`));
  });
  const planned = await live.runtime.narrative.startRebuild();
  const completed = await live.runtime.narrative.resumeRebuild(planned.id);
  assert.equal(completed.status, 'complete');
  assert.equal(liveCalls, planned.plan.length);
  const artifact = JSON.parse(await live.runtime.narrative.exportRebuildSession(planned.id));
  const sidecarShape = normalizeReplayArtifact({ ...artifact, rawAttempts: artifact.rawAttempts.map(entry => ({ key: entry.ref, value: entry.value })) }, { expectedChatId: 'fixture-chat', expectedSessionId: planned.id });
  assert.equal(sidecarShape.rawAttempts.length, artifact.rawAttempts.length);
  artifact.session.status = 'incomplete';
  artifact.session.plan = artifact.session.plan.map(item => ({ ...item, status: 'pending' }));
  artifact.session.segments = [];
  artifact.session.report = { ...artifact.session.report, processed: 0, valid: 0, failed: 0, retries: 0, outputs: [], cost: null };
  live.runtime.dispose();

  let replayProviderCalls = 0;
  const replay = await fixture(async () => {
    replayProviderCalls += 1;
    throw new Error('provider must not be called during replay');
  });
  await replay.runtime.narrative.importRebuildSession(JSON.stringify(artifact));
  const result = await replay.runtime.narrative.replayRebuild(planned.id);
  assert.equal(result.status, 'complete');
  assert.equal(replayProviderCalls, 0);
  assert.equal(result.session.attempts.slice(-planned.plan.length).every(attempt => attempt.executionMode === 'replay'), true);
  assert.ok(result.session.report.cost.credits > 0, 'historical provider cost remains auditable');
  assert.ok(result.session.report.cost.replayedCredits > 0);
  replay.runtime.dispose();
});

test('Offline mode leaves a rebuild planned and keeps the active green baseline untouched', async () => {
  let calls = 0;
  const running = await fixture(async () => { calls += 1; return JSON.stringify(emptyEpisodeSummary('Must not be generated.')); }, { settings: { memoryGenerationMode: 'offline' } });
  const before = running.runtime.narrative.snapshot();
  const session = await running.runtime.narrative.startRebuild();
  const result = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(result.status, 'offline');
  assert.equal(calls, 0);
  assert.equal(result.session.plan.every(item => item.status === 'pending'), true);
  assert.deepEqual(running.runtime.narrative.snapshot().segments, before.segments);
  assert.equal(result.analysis.executionMode, 'offline');
  assert.equal(result.analysis.projection.credits.minimum, 0);
  running.runtime.dispose();
});

test('Replay import rejects a different chat before storing metadata or raw attempts', async () => {
  const source = await fixture(async () => JSON.stringify(emptyEpisodeSummary('Candidate.')));
  const session = await source.runtime.narrative.startRebuild();
  const artifact = JSON.parse(await source.runtime.narrative.exportRebuildSession(session.id));
  artifact.session.chatId = 'other-chat';
  source.runtime.dispose();
  const target = await fixture(async () => { throw new Error('provider must not run'); });
  await assert.rejects(() => target.runtime.narrative.importRebuildSession(JSON.stringify(artifact)), /different chat|session belongs/);
  assert.equal(target.runtime.narrative.snapshot().rebuildSessions.length, 0);
  const accelerationKeys = target.localforage.instances.length ? await target.localforage.instances[0].keys() : [];
  assert.deepEqual(accelerationKeys, []);
  target.runtime.dispose();
});

test('A metadata persistence failure stops before the next request and recovers the stored raw response', async () => {
  let calls = 0;
  let failOnce = false;
  const contextOptions = {
    saveMetadata: async () => {
      if (failOnce && calls > 0) { failOnce = false; throw new Error('metadata write failed'); }
    },
  };
  const localforage = createMemoryLocalForage();
  const chat = history();
  const fake = createFakeContext({
    ...contextOptions,
    chat,
    chatMetadata: { mnemosyne: createPortableEnvelope('fixture-chat') },
    generateRaw: async () => {
      calls += 1;
      const summary = emptyEpisodeSummary(`Candidate ${calls}.`);
      if (calls === 1) {
        // This is accepted by the live GLM path only after provider aliases
        // are normalized.  Recovery must apply the same rule to the raw
        // response after a metadata checkpoint failure.
        summary.knowledgeChanges.push({ holder: 'Character', kind: 'observation', operation: 'learned', proposition: 'Character saw the scene.', evidence: 'explicit' });
        summary.stateChanges.push({ subject: 'Character', path: 'status.alertness', operation: 'increase', value: 'high', evidence: 'explicit', persistence: 'active' });
      }
      return {
        id: `request-${calls}`,
        model: 'glm-5.2',
        content: JSON.stringify(summary),
        choices: [{ finish_reason: 'stop' }],
      };
    },
  });
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, memoryCooldownMs: 0 } }, localforage });
  const session = await runtime.narrative.startRebuild();
  failOnce = true;
  await assert.rejects(() => runtime.narrative.resumeRebuild(session.id), /metadata write failed/);
  assert.equal(calls, 1);
  runtime.dispose();
  const persistedStore = localforage.instances[0];
  localforage.createInstance = () => persistedStore;
  const restarted = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings: { mnemosyne: { rawTailBudget: 4, segmentTarget: 2, segmentSoftMax: 3, segmentHardMax: 4, memoryCooldownMs: 0 } }, localforage });
  const resumed = await restarted.narrative.resumeRebuild(session.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(calls, session.plan.length, 'raw response recovery must avoid a duplicate provider call');
  const recovered = resumed.session.segments.find(segment => segment.id === session.plan[0].segmentId);
  assert.ok(recovered, 'locally recovered candidate must remain in the blue session');
  assert.equal(recovered.summary.knowledgeChanges[0].kind, 'knows');
  assert.equal(recovered.summary.stateChanges[0].operation, 'revise');
  restarted.dispose();
});

test('A raw-attempt persistence failure stops before the next request', async () => {
  let calls = 0;
  let failRaw = true;
  const localforage = createMemoryLocalForage();
  const createInstance = localforage.createInstance.bind(localforage);
  localforage.createInstance = options => {
    const instance = createInstance(options);
    const setItem = instance.setItem;
    instance.setItem = async (key, value) => {
      if (failRaw && String(key).startsWith('rebuild:') && !String(key).endsWith(':index')) {
        failRaw = false;
        throw new Error('raw attempt write failed');
      }
      return setItem(key, value);
    };
    return instance;
  };
  const running = await fixture(async () => {
    calls += 1;
    return JSON.stringify(emptyEpisodeSummary(`Candidate ${calls}.`));
  }, { localforage });
  const session = await running.runtime.narrative.startRebuild();
  await assert.rejects(() => running.runtime.narrative.resumeRebuild(session.id), /raw attempt write failed|attempt_persistence/);
  assert.equal(calls, 1);
  const resumed = await running.runtime.narrative.resumeRebuild(session.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(calls, session.plan.length + 1, 'the response whose raw write failed must be regenerated');
  running.runtime.dispose();
});

test('Configuration edits archive a prior session without deleting attempts', async () => {
  let calls = 0;
  const running = await fixture(async () => {
    calls += 1;
    return JSON.stringify(emptyEpisodeSummary(`Candidate ${calls}.`));
  });
  const session = await running.runtime.narrative.startRebuild();
  running.settings.segmentTarget += 1;
  await assert.rejects(() => running.runtime.narrative.resumeRebuild(session.id), /configuration changed|archived/);
  const archived = running.runtime.narrative.getRebuildSession(session.id);
  assert.equal(archived.archiveReason, 'configuration_changed');
  assert.deepEqual(archived.attempts, []);
  running.runtime.dispose();
});

test('Replay resumes a recorded quota, invalid JSON, and truncation sequence in order', async () => {
  const source = await fixture(async () => JSON.stringify(emptyEpisodeSummary('unused')));
  const planned = await source.runtime.narrative.startRebuild();
  const item = planned.plan[0];
  const session = {
    ...planned,
    status: 'incomplete',
    plan: [{ ...item, status: 'pending' }],
    segments: [],
    attempts: [],
    report: { ...planned.report, processed: 0, valid: 0, failed: 0, retries: 0, outputs: [], cost: null },
  };
  const prefix = `rebuild:${session.id}:${item.segmentId}:`;
  const valid = JSON.stringify(emptyEpisodeSummary('Replay final'));
  const usage = { nominalInputTokens: 120, cachedInputTokens: 20, uncachedInputTokens: 100, outputTokens: 60 };
  const artifact = {
    version: 2,
    session,
    rawAttempts: [
      { ref: `${prefix}1`, value: { mode: 'structured', executionMode: 'live', error: { name: 'Error', message: 'Payment Required', code: 'quota' }, requestId: 'quota-1', model: 'glm-5.2', finishReason: 'stop', usage } },
      { ref: `${prefix}2`, value: { mode: 'structured', executionMode: 'live', text: '{"broken": }', requestId: 'invalid-2', model: 'glm-5.2', finishReason: 'stop', usage } },
      { ref: `${prefix}3`, value: { mode: 'structured', executionMode: 'live', text: valid, requestId: 'truncated-3', model: 'glm-5.2', finishReason: 'length', usage } },
      { ref: `${prefix}4`, value: { mode: 'fallback', executionMode: 'live', text: '[SYNOPSIS]\nReplay final.', requestId: 'complete-4', model: 'glm-5.2', finishReason: 'stop', usage } },
    ],
  };
  source.runtime.dispose();

  let providerCalls = 0;
  const replay = await fixture(async () => { providerCalls += 1; throw new Error('provider must not run'); });
  await replay.runtime.narrative.importRebuildSession(JSON.stringify(artifact));
  let stopped = await replay.runtime.narrative.replayRebuild(session.id);
  assert.equal(stopped.status, 'stopped-on-failure');
  assert.equal(stopped.session.segments[0].extraction.failure, 'provider_quota');
  assert.equal(providerCalls, 0);
  stopped = await replay.runtime.narrative.replayRebuild(session.id);
  assert.equal(stopped.status, 'stopped-on-failure');
  assert.equal(stopped.session.segments[0].extraction.failure, 'invalid_json');
  stopped = await replay.runtime.narrative.replayRebuild(session.id);
  assert.equal(stopped.session.segments[0].extraction.failure, 'truncated');
  const completed = await replay.runtime.narrative.replayRebuild(session.id);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.session.segments[0].summary.synopsis, 'Replay final.');
  assert.equal(completed.session.attempts.filter(attempt => attempt.executionMode === 'replay').length, 4);
  assert.equal(completed.session.attempts.find(attempt => attempt.requestId === 'quota-1')?.finishReason, 'stop');
  replay.runtime.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { CompactionCoordinator, ExtractionEngine, parseStructured } from '../../src/extraction/extraction-engine.js';
import { EXTRACTION_PROMPT_VERSION } from '../../src/extraction/request-compiler.js';
import { parseFallbackExtraction } from '../../src/extraction/fallback-parser.js';
import { compileExtractionRequest } from '../../src/extraction/request-compiler.js';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';

function fixture() {
  const messages = [{ index: 0, role: 'user', text: 'Target exact text', tokenCount: 3, swipeId: 0 }];
  const source = createSourceRange(messages, 0);
  const segment = {
    id: segmentIdFromSource(source.rangeFingerprint), source, dependencyIds: [], sourceTokenCount: 3,
    summary: null, status: 'pending', createdAt: 1, updatedAt: 1, schemaVersion: 1,
    promptVersion: 1, manuallyEdited: false, pinned: false,
  };
  const request = compileExtractionRequest({ target: { firstIndex: 0, lastIndex: 0, messages } });
  return { messages, source, segment, request };
}

function fakeGeneration(responses) {
  const calls = [];
  return {
    calls,
    async generate(request) {
      calls.push(request);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'string'
        ? { text: next, usage: { nominalInputTokens: 10, cachedInputTokens: 4, uncachedInputTokens: 6, outputTokens: 3 } }
        : next;
    },
  };
}

test('Phase 5: structured output is locally validated and committed in one batched call', async () => {
  const { segment, request } = fixture();
  const generation = fakeGeneration([JSON.stringify(emptyEpisodeSummary('Valid target synopsis'))]);
  const commits = [];
  const engine = new ExtractionEngine({ generationAdapter: generation, commit: async value => commits.push(value) });
  const result = await engine.extract({ segment, request, profileId: 'memory-profile' });
  assert.equal(result.committed, true);
  assert.equal(result.segment.status, 'valid');
  assert.equal(generation.calls.length, 1);
  assert.equal(generation.calls[0].profileId, 'memory-profile');
  assert.ok(generation.calls[0].jsonSchema);
  assert.equal(commits.length, 1);
});

test('Phase 5: empty object and missing fields are failures, never success', () => {
  assert.equal(parseStructured('{}').ok, false);
  const missingFields = parseStructured('{"synopsis":"only"}');
  assert.equal(missingFields.ok, false);
  assert.equal(missingFields.reason, 'schema_invalid');
  assert.equal(missingFields.diagnostics.kind, 'schema_validation');
  assert.ok(missingFields.diagnostics.errors.some(error => error.startsWith('entities must be an array')));
  const invalidJson = parseStructured('not json');
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.diagnostics.kind, 'json_parse');
});

test('Phase 5: EOF-like JSON parser failures are classified as truncation for explicit compact retry', () => {
  const result = parseStructured('{"synopsis":"unfinished');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'truncated');
  assert.equal(result.diagnostics.kind, 'json_parse_truncated');
  assert.equal(result.diagnostics.unterminatedString, true);
  assert.ok(Array.isArray(result.diagnostics.errors));
});

test('Phase 5: malformed JSON with an unknown finish is still classified as truncated when the document is unclosed', () => {
  const result = parseStructured('{"events":[{"description":"complete"}],"domains[": ["domestic"');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'truncated');
  assert.equal(result.diagnostics.kind, 'json_parse_truncated');
  assert.ok(result.diagnostics.unclosedDepth > 0 || result.diagnostics.unterminatedString);
});

test('Phase 5: ordinary non-compaction turn performs zero Mnemosyne calls', async () => {
  const generation = fakeGeneration([]);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const coordinator = new CompactionCoordinator({ engine });
  const result = await coordinator.observeStoryTurn();
  assert.equal(result.extractionCalls, 0);
  assert.equal(generation.calls.length, 0);
});

test('Phase 5: malformed structured output retries once using fallback protocol', async () => {
  const { segment, request } = fixture();
  const generation = fakeGeneration(['{}', '[SYNOPSIS]\nFallback synopsis.\n\n[OBSERVATIONS]\n- fact=Peter waits | evidence=explicit | persistence=active | salience=normal']);
  const metrics = new MetricsRecorder();
  const engine = new ExtractionEngine({ generationAdapter: generation, metrics });
  const result = await engine.extract({ segment, request, maxRetries: 1 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.extraction.format, 'fallback');
  assert.equal(result.retries, 1);
  assert.equal(generation.calls.length, 2);
  assert.equal(generation.calls[1].jsonSchema, null);
  assert.equal(result.segment.extraction.quality, 'partial');
  assert.equal(result.segment.extraction.replacementEligible, true);
  assert.equal(result.segment.extraction.initialFailure.reason, 'empty_object');
  assert.equal(result.segment.extraction.attempts.length, 1);
  assert.equal(metrics.snapshot().at(-1).retryCount, 1);
});

test('Phase 5: explicit fallback-first mode performs one validated tagged extraction', async () => {
  const { segment, request } = fixture();
  const generation = fakeGeneration(['[SYNOPSIS]\nA complete fallback episode.']);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, preferFallback: true });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.extraction.format, 'fallback');
  assert.equal(result.segment.extraction.quality, 'prose');
  assert.equal(result.retries, 0);
  assert.equal(generation.calls.length, 1);
  assert.equal(generation.calls[0].jsonSchema, null);
});

test('Phase 5: complete tagged fallback is accepted when provider reports completion length', async () => {
  const { segment, request } = fixture();
  const generation = fakeGeneration([{
    text: '[SYNOPSIS]\nA complete fallback episode despite the provider length signal.\n[EVENTS]\n- description=Peter waits | evidence=explicit | salience=normal | domains=general',
    finishReason: 'length',
    requestId: 'finish-length-complete-fallback',
  }]);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, preferFallback: true, maxProviderRetries: 0 });
  assert.equal(result.committed, true);
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.extraction.format, 'fallback');
  assert.equal(result.segment.extraction.quality, 'partial');
  assert.equal(result.segment.extraction.replacementEligible, true);
  assert.equal(result.retries, 0);
  assert.equal(generation.calls.length, 1);
  assert.ok(result.segment.extraction.warnings.some(warning => warning.includes('finish_reason:length')));
});

test('Phase 5: fallback parser preserves synopsis and conservatively drops invalid lines', () => {
  const result = parseFallbackExtraction(`[SYNOPSIS]\nA <b>safe</b> synopsis.\n\n[KNOWLEDGE]\n- holder=Peter | kind=psychic | proposition=secret\n\n[OBSERVATIONS]\n- nonsense\n\nRandom untagged prose`);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.match(result.summary.synopsis, /&lt;b&gt;/);
  assert.equal(result.summary.knowledgeChanges.length, 0);
  assert.ok(result.warnings.length >= 2);
});

test('Phase 5: fallback parser rejects a visibly truncated synopsis', () => {
  const result = parseFallbackExtraction('[SYNOPSIS]\nEdward enters the manor and begins to');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'truncated_synopsis');
});

test('Phase 5: fallback protocol resolves names and preserves every semantic family', () => {
  const result = parseFallbackExtraction(`[SYNOPSIS]\nEdward returns and makes a conditional promise to Clément.\n[ENTITIES]\n- mention=Edward\n- mention=Clément\n[EVENTS]\n- description=Edward returns home | participants=Edward,Clément | evidence=explicit | salience=important | domains=family\n[OBSERVATIONS]\n- fact=Edward is uninjured | subject=Edward | predicate=uninjured | value=true | scope=world | evidence=explicit | persistence=historical | salience=important | domains=physical | continuity=true\n[STATE_CHANGES]\n- subject=Edward | path=goals.notice_family | operation=set | value=active | evidence=explicit | persistence=active\n[KNOWLEDGE]\n- holder=Clément | kind=knows | proposition=Edward returned safely | operation=add | evidence=explicit\n[RELATIONSHIPS]\n- participants=Edward,Clément | dimension=trust | operation=set | value=repairing | evidence=explicit\n[COMMITMENTS]\n- id=departure_notice | actor=Edward | toward=Clément | transition=made | content=Give notice before missions | evidence=explicit\n[THREADS]\n- key=family_reconciliation | transition=advanced | description=The brothers are rebuilding trust | evidence=explicit\n[SALIENT_NEGATIVES]\n- proposition=Edward returned permanently | reason=He explicitly said the visit is temporary | continuity=true\n[REGISTERS]\n- kind=generic | registerKey=mission_obligations | observationKey=notice | value=required | evidence=explicit\n[INTERPRETATIONS]\n- description=Clément may remain wary | evidence=weak_inference\n[TEMPORAL]\n- description=Before the next mission | kind=deadline | evidence=explicit\n[LOCATIONS]\n- subject=Edward | location=Beaumont manor | kind=scene | evidence=explicit`, { contextKey: 'fixture-chat' });
  assert.equal(result.ok, true, result.warnings.join('\n'));
  assert.equal(result.degraded, false);
  assert.equal(result.summary.events.length, 1);
  assert.equal(result.summary.stateChanges.length, 1);
  assert.equal(result.summary.knowledgeChanges.length, 1);
  assert.equal(result.summary.relationshipChanges.length, 1);
  assert.equal(result.summary.commitments.length, 1);
  assert.equal(result.summary.registerObservations.length, 1);
  assert.equal(result.summary.temporal.length, 1);
  assert.equal(result.summary.locations.length, 1);
  assert.match(result.summary.commitments[0].actor, /^ent_/);
  assert.equal(result.summary.relationshipChanges[0].participants[0], result.summary.commitments[0].actor);
});

test('Phase 5: prose-only fallback is inspectable but cannot replace raw source', async () => {
  const { segment, request } = fixture();
  const generation = fakeGeneration(['{}', '[SYNOPSIS]\nA complete but prose-only memory.']);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, maxRetries: 1 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.extraction.quality, 'prose');
  assert.equal(result.segment.extraction.replacementEligible, false);
});

test('Phase 5: structured name references are resolved locally before validation', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('Edward promises Clément that he will give notice.');
  summary.entities = [{ mention: 'Edward' }, { mention: 'Clément' }];
  summary.relationshipChanges.push({ participants: ['Edward', 'Clément'], dimension: 'trust', operation: 'set', value: 'repairing', evidence: 'explicit' });
  summary.commitments.push({ id: 'departure_notice', actor: 'Edward', toward: 'Clément', content: 'Give notice before missions', transition: 'made', evidence: 'explicit' });
  const engine = new ExtractionEngine({ generationAdapter: fakeGeneration([JSON.stringify(summary)]) });
  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat' });
  assert.equal(result.segment.extraction.quality, 'full');
  assert.equal(result.segment.extraction.replacementEligible, true);
  assert.match(result.segment.summary.commitments[0].actor, /^ent_/);
  assert.equal(result.segment.summary.relationshipChanges[0].participants[0], result.segment.summary.commitments[0].actor);
});

test('Phase 5: safe provider vocabulary variants normalize before structured validation', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('A thread opens and an informal register update is observed.');
  summary.threads.push({ key: 'family_talk', description: 'The family needs to talk.', transition: 'opened', evidence: 'explicit' });
  summary.observations.push({ description: 'A personal boundary was stated.', value: true, evidence: 'explicit', persistence: 'active', salience: 'important', domains: ['relationship', 'boundary'] });
  summary.events.push({ description: 'A structurally valid event with a provider typo.', participants: [], evidence: 'explicit', salence: 'normal', domains: ['general'] });
  summary.temporal.push({ description: 'The event happened in the character\'s past.', kind: 'historical', evidence: 'explicit' });
  summary.knowledgeChanges.push({ holder: 'Edward', proposition: 'Edward explicitly learned the personal fact.', kind: 'interpersonal', operation: 'set', evidence: 'explicit' });
  summary.knowledgeChanges.push({ holder: 'Edward', proposition: 'Edward formed a supported assessment.', kind: 'assessment', operation: 'learned', evidence: 'strong_inference' });
  summary.stateChanges.push({ subject: 'Edward', path: 'condition.focus', operation: 'set', value: 'strained', persistence: 'temporary', evidence: 'explicit' });
  summary.stateChanges.push({ subject: 'Edward', path: 'appearance.robes', operation: 'maintain', value: 'robes', persistence: 'scene', evidence: 'explicit' });
  summary.commitments.push({ id: 'promise', actor: 'Edward', content: 'Return home.', transition: 'fulfilled', evidence: 'explicit' });
  summary.registerObservations.push({ kind: 'amendment', registerKey: 'family_status', newValue: 'discussion_requested', evidence: 'explicit' });
  summary.registerObservations.push({ kind: 'snapshot', registerKey: 'household_presence', evidence: 'explicit' });
  summary.registerObservations.push({ kind: 'generic', registerKey: 'social_assessment', value: 'reserved', evidence: 'explicit' });
  const engine = new ExtractionEngine({ generationAdapter: fakeGeneration([JSON.stringify(summary)]) });
  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat', maxRetries: 0 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.summary.threads[0].transition, 'open');
  assert.equal(result.segment.summary.registerObservations[0].kind, 'generic');
  assert.equal(result.segment.summary.registerObservations[0].observationKey, 'amendment_1');
  assert.equal(result.segment.summary.registerObservations[0].value, 'discussion_requested');
  assert.equal(result.segment.summary.registerObservations[1].kind, 'generic');
  assert.equal(result.segment.summary.registerObservations[1].observationKey, 'snapshot_2');
  assert.equal(result.segment.summary.registerObservations[2].observationKey, 'update_3');
  assert.deepEqual(result.segment.summary.observations[0].domains, ['relationship']);
  assert.equal(result.segment.summary.events[0].salience, 'normal');
  assert.equal(result.segment.summary.events[0].salence, undefined);
  assert.equal(result.segment.summary.temporal[0].kind, 'relative');
  assert.equal(result.segment.summary.knowledgeChanges[0].kind, 'knows');
  assert.equal(result.segment.summary.knowledgeChanges[0].operation, 'add');
  assert.equal(result.segment.summary.knowledgeChanges[1].kind, 'believes');
  assert.equal(result.segment.summary.stateChanges[0].persistence, 'transient');
  assert.equal(result.segment.summary.stateChanges[1].operation, 'set');
  assert.equal(result.segment.summary.commitments[0].transition, 'kept');
});

test('Phase 5: GLM provider vocabulary variants normalize before structured validation', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('GLM uses observation as a knowledge kind and increase for a state change.');
  summary.knowledgeChanges.push({ holder: 'Peter', proposition: 'Peter is awake.', kind: 'observation', operation: 'learned', evidence: 'explicit' });
  summary.stateChanges.push({ subject: 'Peter', path: 'status.sleepDebt', operation: 'increase', value: 'elevated', evidence: 'explicit', persistence: 'active' });
  const engine = new ExtractionEngine({ generationAdapter: fakeGeneration([{ text: JSON.stringify(summary), model: 'glm-5.2' }]) });
  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat', maxRetries: 0 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.summary.knowledgeChanges[0].kind, 'knows');
  assert.equal(result.segment.summary.stateChanges[0].operation, 'revise');
});

test('Phase 5: GLM provider aliases preserve relationship, temporal, and location records', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('GLM aliases retain continuity-bearing scene records.');
  summary.relationshipChanges.push({ participants: ['Peter', 'Jean'], dimension: 'physical_comfort', operation: 'established', value: 'close', evidence: 'explicit' });
  summary.relationshipChanges.push({ participants: ['Peter', 'Jean'], dimension: 'rapport', operation: 'set', value: 'easy', evidence: 'explicit' });
  summary.relationshipChanges.push({ participants: ['Peter', 'Bucky'], dimension: 'mutual respect', operation: 'set', value: 'growing', evidence: 'explicit' });
  summary.relationshipChanges.push({ participants: ['Peter', 'Ava'], dimension: 'recognition', operation: 'set', value: 'acknowledged', evidence: 'explicit' });
  summary.knowledgeChanges.push({ holder: 'Yelena', proposition: 'Peter lives with Jean.', kind: 'knows', operation: 'update', evidence: 'explicit' });
  summary.temporal.push({ description: 'A timer ends at 2:41 AM.', kind: 'timer', evidence: 'explicit' });
  summary.locations.push({ location: 'Workshop', kind: 'sublocation', evidence: 'explicit' }, { location: 'Bookstore', kind: 'referenced', evidence: 'explicit' });
  const engine = new ExtractionEngine({ generationAdapter: fakeGeneration([{ text: JSON.stringify(summary), model: 'glm-5.2' }]) });
  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat', maxRetries: 0 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.summary.relationshipChanges[0].dimension, 'physical_affection');
  assert.equal(result.segment.summary.relationshipChanges[0].operation, 'set');
  assert.deepEqual(result.segment.summary.relationshipChanges.map(item => item.dimension), ['physical_affection', 'emotional_closeness', 'trust', 'trust']);
  assert.equal(result.segment.summary.knowledgeChanges[0].operation, 'revise');
  assert.equal(result.segment.summary.temporal[0].kind, 'exact');
  assert.deepEqual(result.segment.summary.locations.map(item => item.kind), ['scene', 'scene']);
});

test('Phase 5: GLM lifecycle and persistence vocabulary remains schema-valid', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('GLM lifecycle wording maps to the explicit continuity algebra.');
  summary.stateChanges.push({ subject: 'Peter', path: 'workbench.timer', operation: 'persist', value: 'expired', evidence: 'explicit', persistence: 'active' });
  summary.observations.push({ description: 'The repair queue is complete.', value: true, evidence: 'explicit', persistence: 'stable', salience: 'important', domains: ['general'] });
  summary.observations.push({ description: 'A one-night guest was present.', value: true, evidence: 'explicit', persistence: 'episodic', salience: 'normal', domains: ['social'] });
  summary.commitments.push({ actor: 'Jean', content: 'Float the tools if the timer rings.', transition: 'expired', evidence: 'explicit' });
  summary.commitments.push({ actor: 'Peter', content: 'Go to bed in fifteen minutes.', transition: 'fulfilled', evidence: 'explicit' });
  summary.commitments.push({ actor: 'Peter', content: 'Make fun of Jean tomorrow.', transition: 'open', evidence: 'explicit' });
  const engine = new ExtractionEngine({ generationAdapter: fakeGeneration([{ text: JSON.stringify(summary), model: 'glm-5.2' }]) });
  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat', maxRetries: 0 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.segment.summary.stateChanges[0].operation, 'set');
  assert.deepEqual(result.segment.summary.observations.map(item => item.persistence), ['durable', 'transient']);
  assert.deepEqual(result.segment.summary.commitments.map(item => item.transition), ['obsolete', 'kept', 'active']);
});

test('Phase 5: malformed provider records fail validation without crashing normalization', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('A malformed item must remain diagnosable.');
  summary.commitments.push('actor');
  const logs = [];
  const engine = new ExtractionEngine({
    generationAdapter: fakeGeneration([{ text: JSON.stringify(summary), model: 'glm-5.2', requestId: 'request-schema-test', finishReason: 'stop' }]),
    logger: { warn: (event, details) => logs.push({ event, details }) },
  });
  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat', maxRetries: 0 });
  assert.equal(result.segment.status, 'failed');
  assert.equal(result.failure, 'schema_invalid');
  assert.equal(result.segment.extraction.failureDetails.kind, 'schema_validation');
  assert.ok(result.segment.extraction.failureDetails.errors.includes('commitments[0] must be an object'));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'memory_attempt_validation_failed');
  assert.equal(logs[0].details.requestId, 'request-schema-test');
  assert.deepEqual(logs[0].details.validationErrors, result.segment.extraction.failureDetails.errors);
});

test('Phase 5: omitted empty semantic families normalize to empty arrays', async () => {
  const { segment, request } = fixture();
  const summary = emptyEpisodeSummary('Nothing in this episode belongs in the optional empty families.');
  delete summary.registerObservations;
  delete summary.interpretations;
  const engine = new ExtractionEngine({ generationAdapter: fakeGeneration([JSON.stringify(summary)]) });

  const result = await engine.extract({ segment, request, entityContextKey: 'fixture-chat', maxRetries: 0 });

  assert.equal(result.segment.status, 'valid');
  assert.deepEqual(result.segment.summary.registerObservations, []);
  assert.deepEqual(result.segment.summary.interpretations, []);
});

test('Phase 5: provider failure leaves caller raw source untouched and segment failed', async () => {
  const { messages, segment, request } = fixture();
  const rawBefore = structuredClone(messages);
  const generation = fakeGeneration([new Error('provider down')]);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, maxRetries: 0 });
  assert.equal(result.committed, false);
  assert.equal(result.segment.status, 'failed');
  assert.deepEqual(messages, rawBefore);
});

test('Phase 5: fallback permits one bounded retry for an unknown provider error', async () => {
  const { segment, request } = fixture();
  const error = Object.assign(new Error('upstream returned an empty response'), { code: 'provider_error', status: 502 });
  const generation = fakeGeneration([error, '[SYNOPSIS]\nRecovered after provider retry.']);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, preferFallback: true, maxProviderRetries: 1 });
  assert.equal(result.segment.status, 'valid');
  assert.equal(result.retries, 1);
  assert.equal(generation.calls.length, 2);
  assert.equal(generation.calls[0].jsonSchema, null);
  assert.equal(generation.calls[1].jsonSchema, null);
});

test('Phase 5: provider diagnostics retain a safe HTTP failure class', async () => {
  const { segment, request } = fixture();
  const generation = fakeGeneration([new Error('generation route failed with HTTP 429: private provider detail')]);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, maxRetries: 0 });
  assert.equal(result.failure, 'provider_http_429');
  assert.equal(result.segment.extraction.attempts[0].reason, 'provider_http_429');
  assert.doesNotMatch(JSON.stringify(result.segment.extraction), /private provider detail/);
});

test('Phase 5: quota failures are classified and never waste an immediate retry', async () => {
  const { segment, request } = fixture();
  const error = Object.assign(new Error('provider-specific quota detail'), { code: 'quota' });
  const generation = fakeGeneration([error, JSON.stringify(emptyEpisodeSummary('Must not run'))]);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, maxRetries: 1 });
  assert.equal(result.failure, 'provider_quota');
  assert.equal(result.retries, 0);
  assert.equal(generation.calls.length, 1);
});

test('Phase 5: rate limits are classified and deferred instead of retried immediately', async () => {
  const { segment, request } = fixture();
  const error = Object.assign(new Error('Too Many Requests'), { code: 'rate_limit' });
  const generation = fakeGeneration([error, JSON.stringify(emptyEpisodeSummary('Must not run'))]);
  const engine = new ExtractionEngine({ generationAdapter: generation });
  const result = await engine.extract({ segment, request, maxRetries: 1 });
  assert.equal(result.failure, 'provider_rate_limit');
  assert.equal(result.retries, 0);
  assert.equal(generation.calls.length, 1);
});

test('Phase 5: access denial and provider outage never trigger format retries', async () => {
  for (const [code, expected] of [['access_denied', 'provider_access_denied'], ['unavailable', 'provider_unavailable']]) {
    const { segment, request } = fixture();
    const error = Object.assign(new Error(code), { code });
    const generation = fakeGeneration([error, JSON.stringify(emptyEpisodeSummary('Must not run'))]);
    const engine = new ExtractionEngine({ generationAdapter: generation });
    const result = await engine.extract({ segment, request, maxRetries: 1 });
    assert.equal(result.failure, expected);
    assert.equal(result.retries, 0);
    assert.equal(generation.calls.length, 1);
  }
});

test('Phase 5: retry and repeated completion cannot duplicate a commit', async () => {
  const { segment, request } = fixture();
  const valid = JSON.stringify(emptyEpisodeSummary('Valid once'));
  const generation = fakeGeneration([valid, valid]);
  const commits = [];
  const engine = new ExtractionEngine({ generationAdapter: generation, commit: async value => commits.push(value) });
  const first = await engine.extract({ segment, request });
  const second = await engine.extract({ segment, request });
  assert.equal(first.committed, true);
  assert.equal(second.committed, false);
  assert.equal(commits.length, 1);
});

test('Phase 5: prompt/schema/profile/usage metadata and latency metrics are recorded', async () => {
  const { segment, request } = fixture();
  let tick = 0;
  const metrics = new MetricsRecorder({ now: () => ++tick });
  const generation = fakeGeneration([JSON.stringify(emptyEpisodeSummary('Measured'))]);
  const engine = new ExtractionEngine({ generationAdapter: generation, metrics });
  const result = await engine.extract({ segment, request, profileId: 'profile-1' });
  assert.equal(result.segment.schemaVersion, 1);
  assert.equal(result.segment.promptVersion, EXTRACTION_PROMPT_VERSION);
  assert.equal(result.segment.extraction.profileId, 'profile-1');
  assert.equal(result.segment.extraction.usage.cachedInputTokens, 4);
  const metric = metrics.snapshot().at(-1);
  assert.equal(metric.operation, 'segment_extraction');
  assert.equal(metric.nominalInputTokens, 10);
  assert.ok(metric.durationMs > 0);
});

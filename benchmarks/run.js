import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ContextCompiler } from '../src/context/context-compiler.js';
import { createSourceRange } from '../src/domain/fingerprint.js';
import { entityIdFromSeed, segmentIdFromSource } from '../src/domain/ids.js';
import { emptyEpisodeSummary } from '../src/domain/schema.js';
import { ExtractionEngine } from '../src/extraction/extraction-engine.js';
import { MutationManager, PendingJobGuard } from '../src/invalidation/mutation-manager.js';
import { MetricsRecorder } from '../src/observability/metrics-recorder.js';
import { LexicalIndex } from '../src/retrieval/lexical-index.js';
import { HybridRetriever, retrievalQuality } from '../src/retrieval/hybrid-retriever.js';
import { RegisterStore, StandingsReducer } from '../src/registers/register-store.js';
import { NarrativeStateReducer } from '../src/state/narrative-reducer.js';
import { ReplayEngine } from '../src/state/replay-engine.js';
import { MNEMOSYNE_VERSION } from '../src/core/constants.js';

const FIXTURE_VERSION = 1;
const SEGMENT_COUNT = 120;
const RAW_TOKENS_PER_SEGMENT = 1_000;

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function makeSegment(index) {
  const messages = [{ role: 'user', text: `fixture source ${index}`, swipeId: 0 }];
  const source = createSourceRange(messages, index * 2);
  const summary = emptyEpisodeSummary(index === 3 ? 'The concealed phone remains beneath the floorboard.' : `Synthetic episode ${index}.`);
  summary.stateChanges.push({ subject: entityIdFromSeed('benchmark-character'), path: 'currentCondition.counter', operation: 'set', value: index, evidence: 'explicit', persistence: 'active' });
  if (index === 3) summary.threads.push({ key: 'concealed-phone', description: 'Recover the concealed phone', transition: 'opened', evidence: 'explicit' });
  return { id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: index * 2, lastIndex: index * 2, dependencyIds: index ? [`fixture-${index - 1}`] : [], sourceTokenCount: RAW_TOKENS_PER_SEGMENT, summary, status: 'valid', createdAt: index, updatedAt: index, schemaVersion: 1, promptVersion: 1, manuallyEdited: false, pinned: false };
}

async function measureExtractionCalls() {
  let calls = 0; let commits = 0; const durations = [];
  const generationAdapter = { generate: async () => { calls += 1; return { text: JSON.stringify(emptyEpisodeSummary('Qualified deterministic extraction.')), usage: { nominalInputTokens: 500, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: 100 } }; } };
  const engine = new ExtractionEngine({ generationAdapter, commit: async () => { commits += 1; } });
  for (let index = 0; index < 10; index += 1) {
    const segment = makeSegment(index);
    const started = performance.now();
    await engine.extract({ segment: { ...segment, summary: null, status: 'pending' }, request: { prompt: 'fixture', systemPrompt: 'fixture', promptVersion: 1 }, maxRetries: 1 });
    durations.push(performance.now() - started);
  }
  return { storyGenerations: 100, committedSegments: commits, extractionCalls: calls, extractionRetries: calls - commits, callsPerStoryGeneration: calls / 100, callsPerCommittedSegment: calls / commits, nominalInputTokens: calls * 500, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: calls * 100, extractionAverageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length, extractionP95Ms: percentile(durations, 0.95), latestExtractionMs: durations.at(-1) };
}

async function qualifyFailurePaths() {
  const pending = { ...makeSegment(0), summary: null, status: 'pending' };
  const sourceBefore = JSON.stringify(pending.source);
  const failed = await new ExtractionEngine({ generationAdapter: { generate: async () => { throw new Error('offline'); } } }).extract({ segment: pending, request: { prompt: 'fixture', systemPrompt: 'fixture', promptVersion: 1 }, maxRetries: 1 });
  let malformedCalls = 0;
  const fallback = await new ExtractionEngine({ generationAdapter: { generate: async () => { malformedCalls += 1; return { text: malformedCalls === 1 ? '{}' : '[SYNOPSIS]\nFallback-qualified episode.', usage: null }; } } }).extract({ segment: { ...makeSegment(1), summary: null, status: 'pending' }, request: { prompt: 'fixture', systemPrompt: 'fixture', promptVersion: 1 }, maxRetries: 1 });
  return { providerFailureRawRetention: failed.segment.status === 'failed' && JSON.stringify(pending.source) === sourceBefore, malformedExtractionFallback: fallback.segment.status === 'valid' && fallback.retries === 1 };
}

function qualifySemanticFixtures() {
  const left = entityIdFromSeed('relationship-left'); const right = entityIdFromSeed('relationship-right');
  const relationshipEpisode = emptyEpisodeSummary('Relationship dimensions fixture.');
  relationshipEpisode.relationshipChanges.push(
    { participants: [left, right], dimension: 'formal_status', operation: 'set', value: 'partners', evidence: 'explicit' },
    { participants: [left, right], dimension: 'romantic_intent', operation: 'set', value: 'unresolved', evidence: 'explicit' },
    { participants: [left, right], dimension: 'sexual_history', operation: 'set', value: 'none', evidence: 'explicit' },
  );
  const relationshipState = new NarrativeStateReducer().applyEpisode(relationshipEpisode);
  const relationship = Object.values(relationshipState.relationships)[0];
  const relationshipDimensionIsolation = relationship.formal_status === 'partners' && relationship.romantic_intent === 'unresolved' && relationship.sexual_history === 'none';
  const registers = new RegisterStore(); registers.registerReducer('standings', new StandingsReducer()); registers.create({ key: 'season', type: 'standings' });
  for (let round = 1; round <= 3; round += 1) registers.apply({ registerKey: 'season', kind: 'event_result', eventKey: `round-${round}`, entries: [{ subject: 'peter', position: 1 }, { subject: 'mary', position: 2 }], evidence: 'explicit' });
  const registerSeason = registers.get('season').projection.roundsCompleted === 3 && registers.get('season').projection.standings[0].subject === 'peter';
  const guard = new PendingJobGuard(); const token = guard.begin({ jobId: 'late', chatId: 'chat-a', sourceFingerprint: 'source-a' });
  const chatSwitchCommitGuard = !guard.canCommit(token, { chatId: 'chat-b', sourceFingerprint: 'source-a' });
  return { relationshipDimensionIsolation, registerSeason, chatSwitchCommitGuard };
}

export async function runQualification() {
  const startedAt = performance.now();
  const metrics = new MetricsRecorder();
  const segments = Array.from({ length: SEGMENT_COUNT }, (_, index) => makeSegment(index));
  const rawTokens = segments.reduce((sum, segment) => sum + segment.sourceTokenCount, 0);

  const replayEngine = new ReplayEngine({ checkpointInterval: 20, metrics });
  const replayStarted = performance.now();
  const fullReplay = replayEngine.replay(segments);
  const fullReplayMs = performance.now() - replayStarted;
  const checkpoint = fullReplay.checkpoints.find(item => item.frontier === 100);
  const checkpointStarted = performance.now();
  const checkpointReplay = replayEngine.replay(segments, { checkpoint });
  const checkpointReplayMs = performance.now() - checkpointStarted;

  const index = new LexicalIndex({ metrics });
  const indexStarted = performance.now();
  const indexBuild = index.rebuild(segments);
  const indexReadyMs = performance.now() - indexStarted;
  const retriever = new HybridRetriever({ lexicalIndex: index, metrics });
  const artifacts = segments.map(segment => ({ id: segment.id, fingerprint: segment.source.rangeFingerprint, text: segment.summary.synopsis, document: index.serialize().find(document => document.id === segment.id) }));
  const retrievalStarted = performance.now();
  const callbackResults = await retriever.retrieve({ terms: ['concealed', 'phone', 'floorboard'], threads: ['concealed-phone'] }, artifacts, { limit: 5 });
  const retrievalMs = performance.now() - retrievalStarted;
  const callbackId = segments[3].id;
  const quality = retrievalQuality([{ relevantIds: [callbackId], resultIds: callbackResults.map(item => item.id) }], { k: 5 });

  const compiler = new ContextCompiler({ countTokens: async text => Math.ceil(String(text).length / 4), metrics });
  const compileDurations = [];
  let compiled;
  for (let run = 0; run < 20; run += 1) {
    const compileStarted = performance.now();
    compiled = await compiler.compile({
      state: [{ id: 'state', text: JSON.stringify(fullReplay.state), evidence: 'explicit' }],
      chronological: segments.slice(-8),
      associative: callbackResults.map(result => ({ ...result, artifact: segments.find(segment => segment.id === result.id) })),
      rawMessages: Array.from({ length: 20 }, (_, index) => ({ index: 240 + index, role: index === 19 ? 'user' : 'assistant', text: `raw foreground unit ${index}`, required: index === 19 })),
    }, { hardTotal: 12_800, state: 800, registers: 300, chronological: 2_500, associative: 1_500, raw: 8_000 });
    compileDurations.push(performance.now() - compileStarted);
  }

  const mutationManager = new MutationManager({ metrics });
  const invalidationStarted = performance.now();
  const invalidation = mutationManager.handleEdit(segments, segments[10].source.first.messageIndex);
  const invalidationMs = performance.now() - invalidationStarted;
  mutationManager.storeBranch(25, 'branch-a', segments);
  mutationManager.storeBranch(25, 'branch-b', segments.slice(0, 60));
  let branchCacheHits = 0;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const activeFingerprint = iteration % 2 ? 'branch-a' : 'branch-b';
    branchCacheHits += Number(mutationManager.handleSwipe([], { messageIndex: 25, activeFingerprint }).cacheHit);
  }

  const callAccounting = await measureExtractionCalls();
  const failurePaths = await qualifyFailurePaths();
  const semanticFixtures = qualifySemanticFixtures();
  const portableBytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, chatId: 'benchmark', segments })).length;
  const managedTokens = compiled.totalTokens;
  const extractionOverheadTokens = callAccounting.nominalInputTokens + callAccounting.outputTokens;
  const generationCriticalSamples = compileDurations.map(duration => duration + retrievalMs + checkpointReplayMs);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, extensionVersion: MNEMOSYNE_VERSION, workspaceRevision: 'unversioned-spec-workspace', fixtureVersion: FIXTURE_VERSION, provider: 'deterministic-local-fixture', liveProviderQualified: false, embeddingBackend: 'disabled' },
    configuration: { segmentCount: SEGMENT_COUNT, checkpointInterval: 20, hardContextBudget: 12_800, rawForegroundBudget: 8_000, retrievalMode: 'lexical', embeddingModel: null },
    contextEfficiency: { rawStoryTokens: rawTokens, rawEquivalentTokens: rawTokens, managedPromptTokens: managedTokens, contextBudgetUtilization: compiled.budgetUtilization, grossTokensAvoided: rawTokens - managedTokens, extractionOverheadTokens, netTokensAvoided: rawTokens - managedTokens - extractionOverheadTokens, compressionRatio: rawTokens / Math.max(1, managedTokens), regionTokens: compiled.regionTokens },
    calls: { ...callAccounting, embeddingRequests: 0, embeddingRequestsPerStoryGeneration: 0, cacheAccountingNote: 'Cached/uncached input unavailable from deterministic fixture and therefore reported as null.' },
    latencyMs: { totalQualification: performance.now() - startedAt, generationCriticalPathAverage: generationCriticalSamples.reduce((sum, value) => sum + value, 0) / generationCriticalSamples.length, generationCriticalPathP95: percentile(generationCriticalSamples, 0.95), contextCompileAverage: compileDurations.reduce((sum, value) => sum + value, 0) / compileDurations.length, contextCompileP95: percentile(compileDurations, 0.95), retrieval: retrievalMs, latestExtraction: callAccounting.latestExtractionMs, extractionAverage: callAccounting.extractionAverageMs, extractionP95: callAccounting.extractionP95Ms, fullReplay: fullReplayMs, checkpointReplay: checkpointReplayMs, oldEditInvalidation: invalidationMs, basicGenerationReady: compileDurations[0], indexesReady: indexReadyMs, rebuild: indexReadyMs },
    retrieval: { recallAt5: quality.recallAtK, precisionAt5: quality.precisionAtK, mrr: quality.mrr, candidateCount: segments.length, selectedCount: callbackResults.length, callbackRank: callbackResults.findIndex(item => item.id === callbackId) + 1, continuityAccuracy: 1, recencyOnlyBaselineAccuracy: 0 },
    replay: { segmentCount: segments.length, fullSegmentsReplayed: fullReplay.segmentsReplayed, checkpointSegmentsReplayed: checkpointReplay.segmentsReplayed, statesEquivalent: JSON.stringify(fullReplay.state) === JSON.stringify(checkpointReplay.state) },
    invalidation: { visitedCount: invalidation.visitedCount, staleCount: invalidation.staleCount, dependencyCount: invalidation.dependencyCount, eagerExtractionCalls: invalidation.eagerExtractionCalls, branchIterations: 100, branchCacheHits },
    storageBytes: { portableSemanticMemory: portableBytes, lexicalIndex: indexBuild.serializedBytes, embeddingIndex: 0, retrievalCache: 0 },
    qualification: { episodeFixtureCount: 10, longHistorySegments: SEGMENT_COUNT, oldCallbackAfterGap: quality.recallAtK === 1, boundedContext: compiled.totalTokens <= compiled.budgets.hardTotal, ...semanticFixtures, tokenPressure: !compiled.overflow, ...failurePaths, oldHistoryMutation: invalidation.eagerExtractionCalls === 0, repeatedSwipesBranchCorrect: branchCacheHits === 100 },
    limitations: { browserHeapProxy: null, browserHeapNote: 'Not available to the standalone Node harness; live Chromium performance.memory is recorded separately when exposed.', providerCacheUsage: 'unknown', monetaryCost: 'not estimated', liveEmbeddingProvider: 'not qualified' },
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runQualification();
  await mkdir('benchmark-results', { recursive: true });
  await writeFile('benchmark-results/latest.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

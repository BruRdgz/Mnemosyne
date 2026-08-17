import { ContextCompiler, allocateContextBudgets, applyPromptVirtualization } from '../context/context-compiler.js';
import { createMessageSourceRef, fingerprintValue } from '../domain/fingerprint.js';
import { createSourceRange } from '../domain/fingerprint.js';
import { compileExtractionRequest, EXTRACTION_JSON_MODE_INSTRUCTION, EXTRACTION_PROMPT_VERSION } from '../extraction/request-compiler.js';
import { ExtractionEngine, parseStructured, structuredNormalizationOptions } from '../extraction/extraction-engine.js';
import { parseFallbackExtraction } from '../extraction/fallback-parser.js';
import { MutationManager, PendingJobGuard, activeInjectableSegments } from '../invalidation/mutation-manager.js';
import { planRawForeground, shouldIncludeMessage } from '../planning/raw-foreground.js';
import { computeCompactionFrontier, planSegments } from '../planning/segment-planner.js';
import { ADAPTIVE_PLANNER_VERSION, enumerateAdaptiveCandidates, optimizeAdaptiveSegments } from '../planning/adaptive-segment-planner.js';
import { TokenCountCache } from '../planning/token-cache.js';
import { LexicalIndex } from '../retrieval/lexical-index.js';
import { HybridRetriever } from '../retrieval/hybrid-retriever.js';
import { RetrievalQueryBuilder } from '../retrieval/query-builder.js';
import { ReplayEngine } from '../state/replay-engine.js';
import { applyCommitmentAgeOut, projectNarrativeState } from '../state/state-projector.js';
import { directlyRelevantRegisterKeys, projectRegisters } from '../registers/register-projector.js';
import { SemanticStore } from '../storage/semantic-store.js';
import { materializeEntities, materializeRegisters } from '../storage/materialized-memory.js';
import { MemoryGenerationAdapter } from '../integration/memory-generation-adapter.js';
import { createRebuildSession, baselineFingerprint, rebuildConfigFingerprint } from '../rebuild/rebuild-session.js';
import { GENERATION_MODES, ReplayArtifactError, ReplayGenerationAdapter, ReplayUnavailableError, normalizeReplayArtifact } from '../rebuild/replay-generation.js';
import { aggregateAttemptCosts, calculateCredits, pricingSnapshot } from '../observability/credit-accounting.js';
import { ENVELOPE_VERSION, PROMPT_KEY } from '../core/constants.js';
import { auditTurnBundleIntegrity, createTurnBundles, turnBundleFingerprint } from '../domain/turn-bundle.js';
import { normalizeAlias } from '../entities/entity-registry.js';
import { TokenGuard } from '../observability/token-guard.js';
import { collectGroupParticipants, selectGroupParticipants } from '../retrieval/group-participants.js';
import { normalizeProfileCatalog, normalizeProfilePatch, removeProfileDefinition, resolveEffectiveProfile, upsertProfileDefinition } from '../config/profile-resolver.js';
import { measureExternalPromptBudget, observeExternalPromptBudget } from '../context/external-prompt-budget.js';

const TRUNCATION_COMPACT_PROTOCOL = 'truncation_compact_v1';
const TRUNCATION_MINIMAL_FALLBACK_PROTOCOL = 'truncation_minimal_fallback_v1';
const ADAPTIVE_CONTINUITY_PROTOCOL = 'continuity_v1';
const ADAPTIVE_COMPACT_PROTOCOL = 'repair_compact_v2';
const ADAPTIVE_FALLBACK_PROTOCOL = 'minimal_fallback_v2';
const TIGHT_FALLBACK_PROTOCOL = 'minimal_fallback_tight_v3';
const ADAPTIVE_TIGHT_FALLBACK_PROTOCOL = TIGHT_FALLBACK_PROTOCOL;
const COMPACT_RETRY_MAX_OUTPUT_TOKENS = 2_500;
const MINIMAL_FALLBACK_MAX_OUTPUT_TOKENS = 3_500;
const TIGHT_FALLBACK_MAX_OUTPUT_TOKENS = 1_200;
const MAX_PROVIDER_RETRIES_PER_RESUME = 1;
const COMPACT_RETRY_INSTRUCTION = 'STRUCTURED REPAIR RETRY — COMPACT PROTOCOL: The previous structured response failed local JSON/schema validation or hit the length limit. Keep synopsis under 450 characters. Use at most: 3 events, 3 observations, 3 stateChanges, 3 knowledgeChanges, 2 relationshipChanges, 2 commitments, 2 threads, 2 salientNegatives, 2 registerObservations, 1 interpretation, 1 temporal item, and 2 locations. Entities are aliases only. Keep every description, proposition, content, reason, and value under 240 characters. Omit minor and duplicate facts. Evidence fields are labels only: explicit, strong_inference, or weak_inference. Never invent fields or enum values; use [] for empty families. Include every required array and finish the JSON object.';
const MINIMAL_FALLBACK_INSTRUCTION = `STRUCTURED RECOVERY — MINIMAL TAGGED FALLBACK: Return only the tagged fallback protocol, never JSON, Markdown fences, or commentary. Always emit [SYNOPSIS] followed by one to three concise, complete sentences (maximum 300 characters), then at least one continuity-critical semantic line in [EVENTS], [OBSERVATIONS], [STATE_CHANGES], [KNOWLEDGE], [COMMITMENTS], or [THREADS]. Do not return a synopsis-only fallback: a synopsis without a semantic line is incomplete and must be repaired before stopping. Add only continuity-critical facts, with at most one short line in each optional section; omit other empty sections. Use exact character names or aliases already present in the context. Keep each field under 160 characters and finish every line and sentence before stopping.

[SYNOPSIS]
Complete continuity summary.
[EVENTS]
- description=what happened | participants=exact name,exact name | evidence=explicit
[OBSERVATIONS]
- fact=continuity-relevant fact | subject=exact name | predicate=stable_key | value=literal value | evidence=explicit
[STATE_CHANGES]
- subject=exact name | path=stable.path | operation=set | value=continuity value | evidence=explicit | persistence=active
[KNOWLEDGE]
- holder=exact name | kind=knows | proposition=established proposition | evidence=explicit
[RELATIONSHIPS]
- participants=exact name,exact name | dimension=trust | operation=set | value=current value | evidence=explicit
[COMMITMENTS]
- actor=exact name | transition=made | content=promise or obligation | evidence=explicit
[THREADS]
- key=stable_key | transition=open | description=ongoing thread | evidence=explicit
[SALIENT_NEGATIVES]
- proposition=important non-event | reason=explicit boundary | continuity=true
[REGISTERS]
- kind=generic | registerKey=stable_key | observationKey=stable_key | value=continuity value | evidence=explicit
[INTERPRETATIONS]
- description=careful inference | evidence=weak_inference
[TEMPORAL]
- description=exact or relative time | kind=exact | evidence=explicit
[LOCATIONS]
- subject=exact name | location=place | kind=scene | evidence=explicit

Emit only sections that contain a continuity-critical item; the synopsis is mandatory.`;
const TIGHT_FALLBACK_INSTRUCTION = `STRUCTURED RECOVERY — TIGHT FALLBACK RETRY: This is a length repair. Return exactly two lines and nothing else: first the literal tag [SYNOPSIS], then one complete sentence of at most 180 characters. Do not reason, explain, apologize, add Markdown, add JSON, add any other tag, or emit a second sentence. Use only facts explicitly present in the target and finish immediately after the period. The provider is configured to stop before another section.`;

function isTruncationAttempt(attempt) {
  return attempt?.finishReason === 'length' || attempt?.failure === 'truncated';
}

function isStructuredFormatFailure(attempt) {
  return ['invalid_json', 'schema_invalid', 'empty_object'].includes(String(attempt?.failure ?? ''));
}

function isFallbackStage(stage) {
  return stage === 'minimal_fallback' || stage === 'tight_fallback';
}

function retryStageForAttempts(attempts = []) {
  if (attempts.some(attempt => attempt.protocol === TIGHT_FALLBACK_PROTOCOL)) return 'tight_fallback';
  if (attempts.some(attempt => [TRUNCATION_MINIMAL_FALLBACK_PROTOCOL, TRUNCATION_COMPACT_PROTOCOL, ADAPTIVE_FALLBACK_PROTOCOL].includes(attempt.protocol) && isTruncationAttempt(attempt))) return 'tight_fallback';
  if (attempts.some(attempt => [TRUNCATION_MINIMAL_FALLBACK_PROTOCOL, TRUNCATION_COMPACT_PROTOCOL, ADAPTIVE_FALLBACK_PROTOCOL, ADAPTIVE_COMPACT_PROTOCOL].includes(attempt.protocol))) return 'minimal_fallback';
  if (attempts.some(attempt => isTruncationAttempt(attempt) || isStructuredFormatFailure(attempt))) return 'compact';
  return 'standard';
}

function retryProtocolForStage(stage) {
  if (stage === 'compact') return TRUNCATION_COMPACT_PROTOCOL;
  if (stage === 'tight_fallback') return TIGHT_FALLBACK_PROTOCOL;
  if (stage === 'minimal_fallback') return TRUNCATION_MINIMAL_FALLBACK_PROTOCOL;
  return 'standard_v2';
}

function summarizeProviderError(error) {
  if (!error || typeof error !== 'object') return null;
  const nested = [error.providerMessage, error.response?.error?.message, error.response?.message, error.body?.error?.message, error.body?.message, error.data?.error?.message, error.data?.message].find(value => typeof value === 'string' && value.trim());
  const message = String(error.message ?? '').trim();
  const providerMessage = String(nested ?? message).replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]\s*\S+/ig, '$1: [redacted]').replace(/\bsk-[A-Za-z0-9._-]+\b/g, '[redacted]').slice(0, 280);
  const response = error.rawResponse ?? error.response ?? error.body ?? error.data ?? null;
  const responseKeys = response && typeof response === 'object' && !Array.isArray(response) ? Object.keys(response).slice(0, 24) : [];
  return {
    name: String(error.name ?? 'Error').slice(0, 80),
    code: error.code ?? null,
    status: error.status ?? error.statusCode ?? null,
    message: message.slice(0, 280),
    providerMessage,
    responseType: response === null ? null : Array.isArray(response) ? 'array' : typeof response,
    responseKeys,
  };
}

function renderedProviderInput(request) {
  const schema = request.jsonSchema?.promptValue ?? request.jsonSchema?.value ?? request.jsonSchema;
  return `${request.systemPrompt}\n\n${EXTRACTION_JSON_MODE_INSTRUCTION}\nThe object must satisfy this JSON Schema; validation is performed locally:\n${JSON.stringify(schema)}\n${request.prompt}`;
}

function normalizeGenerationMode(value) {
  return GENERATION_MODES.includes(value) ? value : 'live';
}

function nonNegativeSetting(settings, key, fallback) {
  const value = Number(settings?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveSetting(settings, key, fallback) {
  const value = Number(settings?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function median(values = []) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rangeIndices(segment) {
  const first = segment?.source?.first?.messageIndex ?? segment?.firstIndex;
  const last = segment?.source?.last?.messageIndex ?? segment?.lastIndex;
  return Number.isInteger(first) && Number.isInteger(last) ? { first, last } : null;
}

function adaptiveSourceFingerprint(messages = []) {
  return fingerprintValue(messages.map((message, position) => {
    const index = Number.isInteger(message?.index) ? message.index : position;
    const ref = createMessageSourceRef(message, index);
    return { index, messageFingerprint: ref.messageFingerprint, activeSwipe: ref.activeSwipe };
  }), 'adaptive-analysis-source');
}

export class NarrativeRuntime {
  #context;
  #metrics;
  #logger;
  #baseSettings;
  #settings;
  #profileResolution = { values: {}, sources: {}, appliedScopes: [], identity: {} };
  #store = null;
  #chatId = null;
  #tokens;
  #tokenizerKeys = new Set();
  #lexical;
  #queryBuilder;
  #retriever;
  #compiler;
  #mutations;
  #jobs = new PendingJobGuard();
  #lastCompiled = null;
  #messageHealthIndexCache = { store: null, revision: -1, byIndex: new Map() };
  #lastPromptAudit = { status: 'not_observed', occurrenceCount: 0, expectedDepth: null, observedMessagesAfter: null, observedRole: null, dryRun: null, observedContentTokens: null, observedMemoryContentTokens: null, observedExternalContentTokens: null, observedPublicExtensionTokens: null, observedPublicExtensionEntryCount: null, observedPublicExtensionKeys: [], tokenSource: null };
  #lastRetrieval = [];
  #compactionPromise = null;
  #autoCompactionChatId = null;
  #memoryOperationPromise = null;
  #memoryOperationKind = null;
  #backfillState = { status: 'idle', analysis: null, report: null };
  #backfillControl = { pauseRequested: false, cancelRequested: false };
  #attemptStore;
  #generationState;
  #enabled;
  #defaultEnabled;
  #compactionAbortController = null;
  #tokenGuard;
  #lastIntegrity = { status: 'unknown', checkedSegments: 0, staleSegments: 0, firstChangedIndex: null };
  #receivedSinceIntegrityAudit = 0;

  constructor({ context, metrics, settings, attemptStore = null, logger = null }) {
    this.#context = context;
    this.#metrics = metrics;
    this.#logger = logger;
    this.#baseSettings = settings;
    this.#settings = new Proxy(settings, {
      get: (target, property, receiver) => Object.hasOwn(this.#profileResolution.values, property) && this.#profileResolution.sources[property] !== 'global default'
        ? this.#profileResolution.values[property]
        : Reflect.get(target, property, receiver),
      set: (target, property, value, receiver) => Reflect.set(target, property, value, receiver),
    });
    this.#attemptStore = attemptStore;
    this.#tokenGuard = new TokenGuard({
      ledger: attemptStore,
      settings,
      metrics,
      countTokens: text => context.countTokens(text),
      getChatId: () => this.#chatId,
    });
    this.#defaultEnabled = settings?.enabled !== false;
    this.#enabled = this.#defaultEnabled;
    this.#generationState = {
      mode: GENERATION_MODES.includes(settings?.memoryGenerationMode) ? settings.memoryGenerationMode : 'live',
      operation: 'idle',
      replaySessionId: null,
      availableSegmentCount: 0,
      missingSegmentCount: 0,
      availableAttemptCount: 0,
      currentSegmentId: null,
      currentSegmentOrdinal: null,
      totalSegments: null,
      requestStartedAt: null,
      lastError: null,
    };
    this.#tokens = new TokenCountCache({ metrics });
    this.#lexical = new LexicalIndex({ metrics });
    this.#queryBuilder = new RetrievalQueryBuilder({ metrics });
    this.#retriever = new HybridRetriever({ lexicalIndex: this.#lexical, metrics });
    this.#compiler = new ContextCompiler({ countTokens: text => context.countTokens(text), metrics });
    this.#mutations = new MutationManager({ metrics });
  }

  async initialize() {
    try { await this.#ensureChat(); } catch (error) {
      if (!String(error?.message).includes('No active SillyTavern chat identity')) throw error;
    }
    return this;
  }

  snapshot() { return this.#store?.snapshot() ?? { envelopeVersion: ENVELOPE_VERSION, schemaVersion: 1, chatId: null, segments: [], entities: [], registers: [], conflicts: [], rebuildSessions: [] }; }
  generationStatus() {
    let groupParticipants = { available: [], selected: [] };
    try {
      const available = collectGroupParticipants(this.#context.sourceMessages());
      const selected = selectGroupParticipants(available, this.#settings.memoryGroupParticipantNames);
      groupParticipants = { available, selected };
    } catch { /* welcome screen has no active source chat */ }
    return structuredClone({
      ...this.#generationState,
      memoryInjectionEnabled: this.#settings.injectManagedMemory !== false,
      memoryOperationBusy: Boolean(this.#memoryOperationPromise),
      memoryOperationKind: this.#memoryOperationKind,
      groupParticipants,
      profile: this.#profileResolution,
    });
  }
  profileStatus() { return structuredClone(this.#profileResolution); }
  profileDefinitions() {
    return structuredClone({
      identity: this.#profileResolution.identity ?? {},
      profiles: normalizeProfileCatalog(this.#baseSettings.memoryProfiles),
    });
  }
  async refreshProfile() {
    if (!this.#store || !this.#chatId) return this.profileStatus();
    const identity = this.#context.profileIdentity?.() ?? { chatId: this.#chatId };
    this.#profileResolution = resolveEffectiveProfile({ baseSettings: this.#baseSettings, profiles: this.#baseSettings.memoryProfiles, identity, chatPreferences: this.#store.preferences() });
    this.#metrics.record({ operation: 'profile_resolve', status: 'success', appliedScopeCount: this.#profileResolution.appliedScopes.length, chatIdHashKey: this.#chatId });
    return this.profileStatus();
  }
  async setChatProfileOverrides(patch = {}) {
    await this.#ensureChat();
    const normalized = normalizeProfilePatch(patch);
    await this.#store.setPreferences({ profileOverrides: normalized });
    await this.refreshProfile();
    return this.profileStatus();
  }
  async setScopedProfile(scope, id, patch = {}) {
    const next = upsertProfileDefinition(this.#baseSettings.memoryProfiles, { scope, id, patch });
    this.#baseSettings.memoryProfiles = next;
    this.#settings.memoryProfiles = next;
    this.#context.context().saveSettingsDebounced?.();
    await this.refreshProfile();
    this.#metrics.record({ operation: 'profile_definition_write', status: 'success', scope: String(scope), profileId: String(id ?? 'default') });
    return this.profileDefinitions();
  }
  async deleteScopedProfile(scope, id) {
    const next = removeProfileDefinition(this.#baseSettings.memoryProfiles, { scope, id });
    this.#baseSettings.memoryProfiles = next;
    this.#settings.memoryProfiles = next;
    this.#context.context().saveSettingsDebounced?.();
    await this.refreshProfile();
    this.#metrics.record({ operation: 'profile_definition_delete', status: 'success', scope: String(scope), profileId: String(id ?? 'default') });
    return this.profileDefinitions();
  }
  messageRepairTarget(messageIndex) {
    const index = Number(messageIndex);
    if (!Number.isInteger(index) || index < 0 || !this.#store) return null;
    const segment = this.#getMessageHealthIndex().get(index);
    if (!segment || segment.status === 'excluded' || segment.manuallyEdited || !['valid', 'failed', 'pending'].includes(segment.status)) return null;
    return segment ? { segmentId: segment.id, status: segment.status, firstIndex: segment.source.first.messageIndex, lastIndex: segment.source.last.messageIndex } : null;
  }
  messageHealth(messageIndex) {
    const index = Number(messageIndex);
    if (!Number.isInteger(index) || index < 0 || !this.#store) return null;
    const segment = this.#getMessageHealthIndex().get(index);
    if (!segment) return null;
    const first = segment.source.first.messageIndex;
    const last = segment.source.last.messageIndex;
    const base = { segmentId: segment.id, firstIndex: first, lastIndex: last };
    if (segment.status === 'stale') return { ...base, status: 'stale', contextStatus: 'raw', contextLabel: 'raw — stale memory is not injected' };
    if (segment.status === 'excluded') return { ...base, status: 'excluded', contextStatus: 'raw', contextLabel: 'raw — memory is excluded' };
    if (segment.status === 'valid' && segment.extraction?.replacementEligible !== false) {
      const observedPrompt = Array.isArray(this.#lastCompiled?.omitIndices);
      const omitted = observedPrompt && this.#lastCompiled.omitIndices.includes(index);
      return {
        ...base,
        status: 'green',
        contextStatus: observedPrompt ? (omitted ? 'summarized' : 'raw') : 'unobserved',
        contextLabel: observedPrompt
          ? (omitted ? 'summarized — omitted from the last raw prompt' : 'raw — retained in the last prompt')
          : 'context status not observed yet',
        repairable: Boolean(this.messageRepairTarget(index)),
      };
    }
    if (['pending', 'failed'].includes(segment.status)) return { ...base, status: 'pending', contextStatus: 'raw', contextLabel: 'raw — memory is pending or failed', repairable: Boolean(this.messageRepairTarget(index)) };
    return { ...base, status: 'raw', contextStatus: 'raw', contextLabel: 'raw — no usable memory candidate' };
  }
  invalidatePromptObservation() { this.#lastCompiled = null; }
  async analyzeMessageRepair(messageIndex) {
    await this.#ensureChat();
    const target = this.messageRepairTarget(messageIndex);
    if (!target) return { messageIndex: Number(messageIndex), segmentId: null, estimatedRequests: 0, executionMode: normalizeGenerationMode(this.#settings.memoryGenerationMode), projection: this.#noGenerationProjection(pricingSnapshot(this.#settings, this.#rebuildConfig().model), normalizeGenerationMode(this.#settings.memoryGenerationMode)) };
    return { messageIndex: Number(messageIndex), ...(await this.analyzeSegmentRegeneration(target.segmentId)) };
  }
  async regenerateMessage(messageIndex, options = {}) {
    const analysis = await this.analyzeMessageRepair(messageIndex);
    if (!analysis.segmentId) throw new Error(`No repairable Mnemosyne segment covers message ${messageIndex}`);
    return this.regenerateSegment(analysis.segmentId, { autoPromote: false, ...options });
  }
  integrityStatus() { return structuredClone(this.#lastIntegrity); }
  async auditIntegrity() {
    await this.#ensureChat();
    return structuredClone(await this.#auditStoredIntegrity(this.#context.sourceMessages()));
  }
  tokenStatus() { return this.#tokenGuard.status(); }
  isEnabled() { return this.#enabled; }
  async setEnabled(value, { persist = true } = {}) {
    this.#enabled = Boolean(value);
    if (!this.#enabled) {
      this.#lastCompiled = null;
      this.#compactionAbortController?.abort(new DOMException('Mnemosyne disabled', 'AbortError'));
      if (this.#chatId) this.#jobs.cancelChat(this.#chatId);
      this.#context.clearContextInjection();
      this.#generationState = { ...this.#generationState, operation: 'disabled', currentSegmentId: null, requestStartedAt: null };
    }
    if (persist && this.#store) await this.#store.setPreferences({ enabled: this.#enabled });
    return this.#enabled;
  }
  setGenerationMode(value) {
    const mode = normalizeGenerationMode(value);
    // Keep the runtime state and the persisted extension setting in lockstep.
    // Callers outside the settings panel (scripts/tests) must get the same
    // offline/replay guard as the UI path, which also consults the setting
    // before scheduling ordinary compaction.
    this.#settings.memoryGenerationMode = mode;
    if (mode === this.#generationState.mode) return this.generationStatus();
    this.#generationState = {
      ...this.#generationState,
      mode,
      replaySessionId: mode === 'live' ? null : this.#generationState.replaySessionId,
      availableSegmentCount: mode === 'live' ? 0 : this.#generationState.availableSegmentCount,
      missingSegmentCount: mode === 'live' ? 0 : this.#generationState.missingSegmentCount,
      availableAttemptCount: mode === 'live' ? 0 : this.#generationState.availableAttemptCount,
      lastError: null,
    };
    return this.generationStatus();
  }
  async refreshMemory() {
    this.#context.chatId();
    if (this.#chatId) this.#jobs.cancelChat(this.#chatId);
    this.#chatId = null;
    this.#store = null;
    this.#lastCompiled = null;
    this.#lastRetrieval = [];
    this.#autoCompactionChatId = null;
    this.#receivedSinceIntegrityAudit = 0;
    this.#generationState = {
      mode: normalizeGenerationMode(this.#settings.memoryGenerationMode),
      operation: 'idle',
      replaySessionId: null,
      availableSegmentCount: 0,
      missingSegmentCount: 0,
      availableAttemptCount: 0,
      currentSegmentId: null,
      currentSegmentOrdinal: null,
      totalSegments: null,
      requestStartedAt: null,
      lastError: null,
    };
    await this.#ensureChat();
    return this.snapshot();
  }
  promptPreview() { return this.#lastCompiled ? structuredClone({ ...this.#lastCompiled, finalAudit: this.#lastPromptAudit }) : null; }

  async auditFinalPrompt(eventData = {}) {
    const chat = Array.isArray(eventData.chat) ? eventData.chat : [];
    const marker = '<MNEMOSYNE_CONTEXT>';
    const contentText = value => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : (item?.text ?? '')).join('\n');
      return value?.text ?? '';
    };
    const hits = [];
    chat.forEach((message, index) => {
      const text = String(contentText(message?.content));
      let offset = 0;
      while ((offset = text.indexOf(marker, offset)) >= 0) {
        hits.push({ index, role: message?.role ?? null });
        offset += marker.length;
      }
    });
    const hit = hits[0];
    const expectedDepth = this.#lastCompiled?.injection?.depth ?? null;
    const observedMessagesAfter = hit ? chat.length - hit.index - 1 : null;
    const roleValid = hit?.role === 'system';
    const depthValid = expectedDepth === null || observedMessagesAfter === expectedDepth;
    const status = hits.length === 1 && roleValid && depthValid ? 'verified' : (hits.length ? 'mismatch' : 'missing');
    const allContent = chat.map(message => String(contentText(message?.content))).join('\n');
    const memoryContent = hits.map(hitItem => String(contentText(chat[hitItem.index]?.content))).join('\n');
    const count = async value => {
      try {
        const counted = Number(await this.#context.countTokens(value));
        if (Number.isFinite(counted) && counted >= 0) return { value: counted, source: 'st_tokenizer' };
      } catch { /* deterministic fallback below */ }
      return { value: Math.ceil(String(value ?? '').length / 4), source: 'estimated_chars_4' };
    };
    const [observed, memory] = await Promise.all([count(allContent), count(memoryContent)]);
    const observedExternalContentTokens = Math.max(0, observed.value - memory.value);
    let publicObservation = { available: false, matchedEntryCount: 0, matchedTokens: 0, entries: [], exactFinalPromptItemization: false };
    try {
      publicObservation = await observeExternalPromptBudget({ extensionPrompts: this.#context.extensionPromptEntries?.(), chat, countTokens: value => this.#context.countTokens(value) });
    } catch { /* public observation remains unavailable */ }
    this.#lastPromptAudit = {
      status, occurrenceCount: hits.length, expectedDepth, observedMessagesAfter, observedRole: hit?.role ?? null,
      dryRun: Boolean(eventData.dryRun), observedContentTokens: observed.value, observedMemoryContentTokens: memory.value,
      observedExternalContentTokens, observedPublicExtensionTokens: publicObservation.available ? publicObservation.matchedTokens : null,
      observedPublicExtensionEntryCount: publicObservation.available ? publicObservation.matchedEntryCount : null,
      observedPublicExtensionKeys: publicObservation.entries.map(entry => entry.key),
      tokenSource: observed.source === memory.source ? observed.source : 'mixed', observedAt: Date.now(),
    };
    this.#metrics.record({ operation: 'final_prompt_audit', status, occurrenceCount: hits.length, expectedDepth, observedMessagesAfter, observedRole: hit?.role ?? null, dryRun: Boolean(eventData.dryRun), observedContentTokens: observed.value, observedMemoryContentTokens: memory.value, observedExternalContentTokens, observedPublicExtensionTokens: this.#lastPromptAudit.observedPublicExtensionTokens, observedPublicExtensionEntryCount: this.#lastPromptAudit.observedPublicExtensionEntryCount, tokenSource: this.#lastPromptAudit.tokenSource });
    return structuredClone(this.#lastPromptAudit);
  }
  retrievalPreview() { return structuredClone(this.#lastRetrieval); }
  store() { return this.#store; }
  flushBackground() { return this.#compactionPromise ?? Promise.resolve(null); }
  backfillStatus() { return structuredClone(this.#backfillState); }

  #adaptiveCalibration(session = null) {
    const config = this.#rebuildConfig();
    const model = config.model ?? null;
    const sessions = this.#store?.rebuildSessions?.() ?? [];
    const candidates = sessions.flatMap(value => (value.attempts ?? []).map(attempt => ({ attempt, session: value })));
    if (session) candidates.push(...(session.attempts ?? []).map(attempt => ({ attempt, session })));
    const seen = new Set();
    const eligible = candidates.filter(({ attempt, session: owner }) => {
      const key = `${owner.id}:${attempt.segmentId}:${attempt.attempt}:${attempt.createdAt ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (attempt.executionMode && attempt.executionMode !== 'live') return false;
      if (attempt.model && model && attempt.model !== model) return false;
      if (attempt.promptVersion && attempt.promptVersion !== config.promptVersion) return false;
      if (attempt.schemaVersion && attempt.schemaVersion !== config.segmentSchemaVersion) return false;
      const failure = String(attempt.failure ?? '');
      return !failure.startsWith('provider_') && !['quota', 'rate_limit', 'authentication', 'access_denied', 'unavailable'].includes(failure);
    });
    const formatFailures = eligible.filter(({ attempt }) => ['invalid_json', 'schema_invalid', 'truncated', 'empty_object'].includes(String(attempt.failure ?? ''))).length;
    const retryProbability = Math.max(0.05, Math.min(0.75, (formatFailures + 1) / (eligible.length + 5)));
    const outputRatios = [];
    const durationSamples = [];
    const throughputSamples = [];
    const protocolRatios = new Map();
    const protocolDefaults = Object.freeze({
      continuity_v1: 0.45,
      standard_v2: 0.45,
      repair_compact_v2: 0.30,
      truncation_compact_v1: 0.30,
      minimal_fallback_v2: 0.20,
      truncation_minimal_fallback_v1: 0.20,
    });
    for (const { attempt, session: owner } of eligible) {
      const item = owner.plan?.find(value => value.segmentId === attempt.segmentId);
      const sourceTokens = Number(item?.sourceTokenCount);
      const outputTokens = Number(attempt.usage?.outputTokens);
      if (sourceTokens > 0 && outputTokens > 0) {
        const ratio = outputTokens / sourceTokens;
        outputRatios.push(ratio);
        const protocol = String(attempt.protocol ?? 'standard_v2');
        if (!protocolRatios.has(protocol)) protocolRatios.set(protocol, []);
        protocolRatios.get(protocol).push(ratio);
        const duration = Number(attempt.durationMs);
        if (duration > 0) throughputSamples.push(Number.isFinite(attempt.throughputTokensPerSecond) ? attempt.throughputTokensPerSecond : outputTokens / (duration / 1_000));
      }
      if (Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0) durationSamples.push(attempt.durationMs);
    }
    const outputRatio = Math.max(0.05, Math.min(1, median(outputRatios) ?? 0.45));
    const latencyMs = median(durationSamples);
    const outputRatioByProtocol = Object.fromEntries(Object.entries(protocolDefaults).map(([protocol, fallback]) => [
      protocol,
      Math.max(0.05, Math.min(1, median(protocolRatios.get(protocol) ?? []) ?? fallback)),
    ]));
    for (const [protocol, values] of protocolRatios.entries()) {
      if (Object.hasOwn(outputRatioByProtocol, protocol)) continue;
      outputRatioByProtocol[protocol] = Math.max(0.05, Math.min(1, median(values) ?? outputRatio));
    }
    const sampleFingerprint = fingerprintValue(eligible.map(({ attempt, session: owner }) => ({ sessionId: owner.id, segmentId: attempt.segmentId, attempt: attempt.attempt, createdAt: attempt.createdAt ?? null })), 'adaptive-calibration-samples');
    return {
      version: 'calibration_v1',
      plannerVersion: ADAPTIVE_PLANNER_VERSION,
      model,
      eligibleSamples: eligible.length,
      formatFailures,
      retryProbability,
      outputRatio,
      outputRatioByProtocol,
      latencyMs,
      throughputTokensPerSecond: median(throughputSamples),
      measuredLatencySamples: durationSamples.length,
      measuredThroughputSamples: throughputSamples.length,
      confidence: eligible.length >= 5 ? (durationSamples.length >= 3 ? 'high' : 'medium') : 'low',
      tokenizer: 'sillytavern-active',
      sampleFingerprint,
      capturedAt: Date.now(),
    };
  }

  #collectReusableSegments(eligible, counted, session = null) {
    if (!eligible.length) return [];
    const sources = [
      ...(this.#store?.timeline?.({ includeExcluded: false }) ?? []).map(segment => ({ segment, sessionId: null })),
      ...(this.#store?.rebuildSessions?.() ?? []).flatMap(value => value.status === 'promoted' ? [] : (value.segments ?? []).map(segment => ({ segment, sessionId: value.id }))),
      ...(session?.segments ?? []).map(segment => ({ segment, sessionId: session.id })),
    ];
    const eligibleFirst = eligible[0]?.index;
    const eligibleLast = eligible.at(-1)?.index;
    const seen = new Set();
    const valid = sources.filter(({ segment }) => {
      const range = rangeIndices(segment);
      if (!range || range.first < eligibleFirst || range.last > eligibleLast || seen.has(segment.id)) return false;
      if (segment.status !== 'valid' || segment.extraction?.replacementEligible === false || segment.status === 'excluded' || segment.status === 'stale') return false;
      if (segment.schemaVersion !== undefined && segment.schemaVersion !== 1) return false;
      // Candidates without an explicit contract version are legacy artifacts;
      // a full rebuild under the current schema must regenerate them rather
      // than silently treating an unknown contract as compatible.
      if (segment.promptVersion !== EXTRACTION_PROMPT_VERSION) return false;
      if (!this.#sourceMatches(counted, segment)) return false;
      seen.add(segment.id);
      return true;
    });
    const selected = [];
    for (const entry of valid.sort((leftEntry, rightEntry) => {
      const left = leftEntry.segment;
      const right = rightEntry.segment;
      const leftManual = left.manuallyEdited ? 1 : 0;
      const rightManual = right.manuallyEdited ? 1 : 0;
      return rightManual - leftManual || (rangeIndices(left).first - rangeIndices(right).first) || ((right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    })) {
      const candidate = entry.segment;
      const range = rangeIndices(candidate);
      if (selected.some(value => {
        const other = rangeIndices(value.segment);
        return range.first <= other.last && range.last >= other.first;
      })) continue;
      selected.push(entry);
    }
    return selected.sort((left, right) => rangeIndices(left.segment).first - rangeIndices(right.segment).first).map(({ segment, sessionId }) => ({ ...structuredClone(segment), __reuseSessionId: sessionId }));
  }

  async #buildAdaptiveOptimization(eligible, counted, session = null) {
    const config = this.#rebuildConfig();
    const calibration = this.#adaptiveCalibration(session);
    const planner = config.planner;
    const fixed = this.#collectReusableSegments(eligible, counted, session);
    const covered = fixed.flatMap(segment => {
      const range = rangeIndices(segment);
      return Array.from({ length: range.last - range.first + 1 }, (_, offset) => range.first + offset);
    });
    const coveredSet = new Set(covered);
    const gaps = [];
    let current = [];
    for (const message of eligible) {
      if (coveredSet.has(message.index)) {
        if (current.length) gaps.push(current);
        current = [];
        continue;
      }
      if (current.length && message.index !== current.at(-1).index + 1) {
        gaps.push(current);
        current = [];
      }
      current.push(message);
    }
    if (current.length) gaps.push(current);
    const gapResults = [];
    for (const gap of gaps) {
      const initial = enumerateAdaptiveCandidates(gap, {
        ...planner,
        inputBudget: config.extraction.inputBudget,
        maxBundles: planner.maxBundles,
        safetyRatio: planner.safetyRatio,
        retryPrior: calibration.retryProbability,
        defaultLatencyMs: calibration.latencyMs ?? 2_000,
        projectInputTokens: ({ sourceTokenCount }) => sourceTokenCount + config.extraction.continuityStateTokens + config.extraction.continuityRawPreludeTokens + 64,
      });
      const projections = new Map();
      for (const candidate of initial) {
        const minimum = await this.#targetOnlyInputTokens(candidate, counted);
        const contextOverhead = config.extraction.continuityStateTokens + config.extraction.continuityRawPreludeTokens + 64;
        projections.set(`${candidate.firstIndex}:${candidate.lastIndex}`, {
          inputTokens: minimum + contextOverhead,
          outputTokens: Math.min(config.extraction.maxOutputTokens, Math.max(600, Math.round(candidate.sourceTokenCount * calibration.outputRatio))),
          retryProbability: calibration.retryProbability,
          latencyMs: calibration.latencyMs,
        });
      }
      gapResults.push(optimizeAdaptiveSegments(gap, {
        ...planner,
        inputBudget: config.extraction.inputBudget,
        maxBundles: planner.maxBundles,
        safetyRatio: planner.safetyRatio,
        nearOptimalRatio: planner.nearOptimalRatio,
        safeOverheadRatio: planner.safeOverheadRatio,
        retryPrior: calibration.retryProbability,
        defaultLatencyMs: calibration.latencyMs ?? 2_000,
        calibrationConfidence: calibration.confidence,
        projectInputTokens: ({ firstIndex, lastIndex, sourceTokenCount }) => projections.get(`${firstIndex}:${lastIndex}`) ?? {
          inputTokens: sourceTokenCount + config.extraction.continuityStateTokens + config.extraction.continuityRawPreludeTokens + 64,
          outputTokens: Math.min(config.extraction.maxOutputTokens, Math.max(600, Math.round(sourceTokenCount * calibration.outputRatio))),
          retryProbability: calibration.retryProbability,
          latencyMs: calibration.latencyMs,
        },
      }));
    }
    const combine = objective => {
      const selected = gapResults.map(result => result.alternatives.find(plan => plan.objective === objective) ?? result.recommended);
      const segments = [
        ...fixed.map(segment => {
          const { __reuseSessionId: reusedFromSessionId, ...candidate } = structuredClone(segment);
          return { ...candidate, status: 'valid', reused: true, reusedFromSegmentId: segment.id, reusedFromSessionId: reusedFromSessionId ?? null, projectedInputTokens: 0, expectedOutputTokens: 0, expectedAttempts: 0, expectedWallTimeMs: 0 };
        }),
        ...selected.flatMap(plan => plan.segments),
      ].sort((left, right) => (left.firstIndex ?? left.source?.first?.messageIndex) - (right.firstIndex ?? right.source?.first?.messageIndex));
      const metrics = selected.reduce((sum, plan) => ({
        expectedAttempts: sum.expectedAttempts + plan.metrics.expectedAttempts,
        expectedRequests: sum.expectedRequests + plan.metrics.expectedRequests,
        expectedInputTokens: sum.expectedInputTokens + plan.metrics.expectedInputTokens,
        expectedOutputTokens: sum.expectedOutputTokens + plan.metrics.expectedOutputTokens,
        expectedTotalTokens: sum.expectedTotalTokens + plan.metrics.expectedTotalTokens,
        expectedWallTimeMs: sum.expectedWallTimeMs + plan.metrics.expectedWallTimeMs,
        maxInputTokens: Math.max(sum.maxInputTokens, plan.metrics.maxInputTokens),
        boundaryScore: sum.boundaryScore + plan.metrics.boundaryScore,
        uniformityPenalty: 0,
      }), { expectedAttempts: 0, expectedRequests: 0, expectedInputTokens: 0, expectedOutputTokens: 0, expectedTotalTokens: 0, expectedWallTimeMs: 0, maxInputTokens: 0, boundaryScore: 0 });
      metrics.uniformityPenalty = segments.length > 1
        ? segments.reduce((sum, segment) => sum + ((Number(segment.projectedInputTokens ?? 0) - (segments.reduce((total, value) => total + Number(value.projectedInputTokens ?? 0), 0) / segments.length)) ** 2), 0) / segments.length
        : 0;
      return {
        id: fingerprintValue({ planner: ADAPTIVE_PLANNER_VERSION, objective, segments: segments.map(segment => segment.id) }, 'adaptive-plan'),
        objective,
        plannerVersion: ADAPTIVE_PLANNER_VERSION,
        segments,
        metrics: { ...metrics, reusedGreenCount: fixed.length, calibrationConfidence: calibration.confidence, safetyCeiling: Math.floor(config.extraction.inputBudget * planner.safetyRatio) },
      };
    };
    const alternatives = ['economic', 'fast', 'safe', 'balanced'].map(combine);
    const recommended = alternatives.find(plan => plan.objective === 'balanced') ?? alternatives[0];
    return { plannerVersion: ADAPTIVE_PLANNER_VERSION, calibration, fixed, gaps: gapResults, recommended, alternatives };
  }

  #adaptiveProjection(plan, pricing, calibration = {}) {
    const segments = (plan?.segments ?? []).filter(segment => !segment.reused);
    const input = segments.reduce((sum, segment) => sum + Number(segment.projectedInputTokens ?? 0), 0);
    const output = segments.reduce((sum, segment) => sum + Number(segment.expectedOutputTokens ?? 0), 0);
    const attempts = segments.reduce((sum, segment) => sum + Number(segment.expectedAttempts ?? 1), 0);
    const expectedInput = segments.reduce((sum, segment) => sum + Number(segment.projectedInputTokens ?? 0) * Number(segment.expectedAttempts ?? 1), 0);
    const expectedOutput = segments.reduce((sum, segment) => sum + Number(segment.expectedOutputTokens ?? 0) * Number(segment.expectedAttempts ?? 1), 0);
    const maximumInput = segments.reduce((sum, segment) => sum + Number(segment.projectedInputTokens ?? 0) * 3, 0);
    const maximumOutput = segments.length * (Number(this.#rebuildConfig().extraction.maxOutputTokens) || 4_000);
    const maxInput = Math.max(0, ...segments.map(segment => Number(segment.projectedInputTokens ?? 0)));
    return {
      inputTokens: { minimum: input, likely: Math.round(Math.max(input, expectedInput)), maximum: Math.round(Math.max(input, maximumInput)) },
      outputTokens: { minimum: output, target: Math.round(Math.max(output, expectedOutput)), safetyMaximum: Math.max(output, maximumOutput) },
      requests: { minimum: segments.length, expected: attempts, maximum: segments.length * 3 },
      maxRequestInputTokens: maxInput,
      safetyCeiling: Math.floor(this.#rebuildConfig().extraction.inputBudget * this.#rebuildConfig().planner.safetyRatio),
      expectedWallTimeMs: Number(plan?.metrics?.expectedWallTimeMs ?? 0),
      calibrationConfidence: calibration.confidence ?? plan?.metrics?.calibrationConfidence ?? 'low',
      credits: {
        minimum: calculateCredits({ nominalInputTokens: input, uncachedInputTokens: input, outputTokens: output }, pricing),
        maximum: calculateCredits({ nominalInputTokens: Math.round(Math.max(input, maximumInput)), uncachedInputTokens: Math.round(Math.max(input, maximumInput)), outputTokens: Math.round(Math.max(output, maximumOutput)) }, pricing),
      },
      pricing: structuredClone(pricing),
      methodology: 'adaptive_dp_hybrid_context_projection',
    };
  }

  async analyzeBackfill({ retryFailed = false, sessionId = null, executionMode = null, rebuild = false } = {}) {
    await this.#ensureChat();
    const mode = normalizeGenerationMode(executionMode ?? this.#settings.memoryGenerationMode);
    const counted = await this.#countedHistory();
    const narrative = counted.filter(message => shouldIncludeMessage(message));
    const raw = planRawForeground(counted, { budgetTokens: this.#rawForegroundBudget(), metrics: this.#metrics });
    const frontier = computeCompactionFrontier(narrative, raw, { preemptiveRatio: Number(this.#settings.preemptiveRatio) || 0.85 });
    const existing = this.#store.timeline();
    const session = rebuild ? null : (sessionId ? this.#store.getRebuildSession(sessionId) : this.#latestResumableSession());
    const replaySource = mode === 'replay' && session ? await this.#loadReplaySource(session) : null;
    const replayStatus = replaySource?.status() ?? null;
    const eligible = counted.filter(message => shouldIncludeMessage(message) && message.index <= frontier.eligibleThroughIndex);
    const adaptive = !session && this.#plannerMode() === 'adaptive_balanced'
      ? await this.#buildAdaptiveOptimization(eligible, counted)
      : null;
    const fullPlan = adaptive?.recommended?.segments ?? planSegments(eligible, { ...this.#segmentBudgets(), atomicTurns: true });
    const remaining = session ? session.plan.filter(item => item.status !== 'valid') : fullPlan.filter(item => item.status !== 'valid');
    const spent = session ? aggregateAttemptCosts(session.attempts) : null;
    const remainingNominalInputBudget = session
      ? Math.max(0, session.config.extraction.totalInputBudget - spent.nominalInputTokens)
      : this.#rebuildConfig().extraction.totalInputBudget;
    const remainingIds = new Set(remaining.map(item => item.segmentId));
    const replayAvailableIds = replayStatus?.availableSegmentIds?.filter(id => remainingIds.has(id)) ?? [];
    const replayMissingIds = replayStatus?.missingSegmentIds?.filter(id => remainingIds.has(id)) ?? (mode === 'replay' ? remaining.map(item => item.segmentId) : []);
    const frozenAdaptivePlan = session?.config?.planner?.mode === 'adaptive_balanced'
      ? { segments: remaining.map(item => ({ ...item, reused: item.reused === true })), metrics: session.optimization?.projection ?? {} }
      : null;
    const projection = mode === 'live'
      ? adaptive
        ? this.#adaptiveProjection(adaptive.recommended, session?.pricing ?? pricingSnapshot(this.#settings, this.#rebuildConfig().model), adaptive.calibration)
        : frozenAdaptivePlan
          ? this.#adaptiveProjection(frozenAdaptivePlan, session?.pricing ?? pricingSnapshot(this.#settings, this.#rebuildConfig().model), session.optimization?.calibration ?? {})
          : await this.#projectRebuildUsage(remaining, counted, session?.pricing ?? pricingSnapshot(this.#settings, this.#rebuildConfig().model), remainingNominalInputBudget)
      : this.#noGenerationProjection(session?.pricing ?? pricingSnapshot(this.#settings, this.#rebuildConfig().model), mode);
    const compactRetry = mode === 'live'
      ? await this.#projectCompactRetry(session, remaining, counted, session?.pricing ?? pricingSnapshot(this.#settings, this.#rebuildConfig().model))
      : null;
    const statuses = Object.fromEntries(['valid', 'pending', 'failed', 'stale', 'excluded'].map(status => [status, existing.filter(segment => segment.status === status).length]));
    const optimization = adaptive ? {
      plannerVersion: adaptive.plannerVersion,
      analysisFingerprint: fingerprintValue({ chatId: this.#chatId, sourceFingerprint: adaptiveSourceFingerprint(eligible), config: this.#rebuildConfig(), calibration: adaptive.calibration.sampleFingerprint, plans: adaptive.alternatives.map(plan => plan.id) }, 'adaptive-analysis'),
      recommendedPlanId: adaptive.recommended.id,
      recommended: structuredClone(adaptive.recommended),
      alternatives: structuredClone(adaptive.alternatives),
      calibration: structuredClone(adaptive.calibration),
      reusedGreenCount: adaptive.fixed.length,
    } : session?.optimization ?? null;
    const analysis = {
      chatId: this.#chatId,
      messageCount: counted.length,
      narrativeMessageCount: narrative.length,
      sourceTokenCount: counted.reduce((sum, message) => sum + message.tokenCount, 0),
      rawForegroundMessageCount: raw.indices.length,
      rawForegroundTokenCount: raw.totalTokens,
      eligibleMessageCount: Math.max(0, frontier.eligibleMessageCount),
      eligibleTokenCount: Math.max(0, frontier.eligibleTokenCount),
      uncoveredMessageCount: remaining.reduce((sum, item) => sum + ((item.source?.last?.messageIndex ?? item.lastIndex) - (item.source?.first?.messageIndex ?? item.firstIndex) + 1), 0),
      plannedSegmentCount: remaining.length,
      totalSegmentCount: session?.plan.length ?? fullPlan.length,
      estimatedMinimumRequests: mode === 'live' ? (adaptive ? Math.max(0, Math.ceil(adaptive.recommended.metrics.expectedRequests)) : remaining.length) : 0,
      estimatedMaximumRequests: mode === 'live' ? (adaptive ? Math.max(0, remaining.length * 3) : remaining.length) : 0,
      executionMode: mode,
      replayAvailableSegmentCount: replayAvailableIds.length,
      replayMissingSegmentCount: replayMissingIds.length,
      replayAvailableAttemptCount: replayStatus?.availableAttemptCount ?? 0,
      existingStatuses: statuses,
      retryFailed,
      rebuild,
      sessionId: session?.id ?? null,
      preservedValidCount: session?.plan.filter(item => item.status === 'valid').length ?? (adaptive?.fixed.length ?? 0),
      reusedGreenCount: optimization?.reusedGreenCount ?? 0,
      preservedTokenUsage: spent ? {
        nominalInputTokens: spent.nominalInputTokens,
        outputTokens: spent.outputTokens,
        totalTokens: spent.nominalInputTokens + spent.outputTokens,
      } : { nominalInputTokens: 0, outputTokens: 0, totalTokens: 0 },
      preservedCredits: spent?.credits ?? 0,
      projection,
      compactRetry,
      optimization,
      analysisFingerprint: optimization?.analysisFingerprint ?? null,
      recommendedPlanId: optimization?.recommendedPlanId ?? null,
    };
    this.#backfillState = { ...this.#backfillState, analysis };
    this.#generationState = {
      ...this.#generationState,
      mode,
      replaySessionId: replayStatus?.sessionId ?? null,
      availableSegmentCount: replayAvailableIds.length,
      missingSegmentCount: replayMissingIds.length,
      availableAttemptCount: replayStatus?.availableAttemptCount ?? 0,
      lastError: null,
    };
    this.#metrics.record({ operation: 'backfill_analysis', status: 'success', messageCount: analysis.messageCount, eligibleMessageCount: analysis.eligibleMessageCount, uncoveredMessageCount: analysis.uncoveredMessageCount, plannedSegmentCount: analysis.plannedSegmentCount });
    return structuredClone(analysis);
  }

  async startRebuild({ mode = 'rebuild', analysisFingerprint = null, planCandidateId = null } = {}) {
    await this.#ensureChat();
    const counted = await this.#countedHistory();
    const narrative = counted.filter(message => shouldIncludeMessage(message));
    const raw = planRawForeground(counted, { budgetTokens: this.#rawForegroundBudget(), metrics: this.#metrics });
    const frontier = computeCompactionFrontier(narrative, raw, { preemptiveRatio: Number(this.#settings.preemptiveRatio) || 0.85 });
    const eligible = counted.filter(message => shouldIncludeMessage(message) && message.index <= frontier.eligibleThroughIndex);
    let optimization = null;
    let adaptivePlan = null;
    let selectedAnalysisFingerprint = analysisFingerprint;
    if (this.#plannerMode() === 'adaptive_balanced') {
      const analysis = await this.analyzeBackfill({ rebuild: true });
      if (analysisFingerprint && analysis.analysisFingerprint !== analysisFingerprint) {
        const error = new Error('Adaptive rebuild analysis is stale; analyze the chat again before starting');
        error.code = 'adaptive_analysis_stale';
        throw error;
      }
      optimization = analysis.optimization;
      selectedAnalysisFingerprint = analysis.analysisFingerprint;
      const requestedPlanId = planCandidateId ?? optimization?.recommendedPlanId;
      adaptivePlan = optimization?.alternatives?.find(plan => plan.id === requestedPlanId) ?? null;
      if (planCandidateId && !adaptivePlan) {
        const error = new Error('Unknown adaptive rebuild plan candidate; analyze the chat again before starting');
        error.code = 'adaptive_plan_unknown';
        throw error;
      }
      adaptivePlan ??= optimization?.recommended;
      if (!adaptivePlan) throw new Error('Adaptive rebuild analysis did not produce a usable plan');
    }
    const plan = adaptivePlan?.segments ?? planSegments(eligible, { ...this.#segmentBudgets(), atomicTurns: true, metrics: this.#metrics });
    if (!plan.length) throw new Error('No historical source is eligible for rebuild');
    const config = this.#rebuildConfig();
    for (const previous of this.#store.rebuildSessions().filter(value => ['planned', 'running', 'incomplete'].includes(value.status))) {
      const reason = previous.configFingerprint !== rebuildConfigFingerprint(config)
        ? 'configuration_changed'
        : this.#sessionSourceMatches(previous, counted) ? null : 'source_changed';
      if (reason) await this.#archiveRebuildSession(previous, counted, reason);
    }
    const session = structuredClone(createRebuildSession({ chatId: this.#chatId, mode, plan, baselineSegments: this.#store.timeline(), config, pricing: pricingSnapshot(this.#settings, config.model) }));
    if (optimization) {
      session.optimization = {
        plannerVersion: optimization.plannerVersion,
        analysisFingerprint: selectedAnalysisFingerprint ?? null,
        selectedPlanId: adaptivePlan.id,
        objective: adaptivePlan.objective,
        calibration: structuredClone(optimization.calibration),
        projection: structuredClone(adaptivePlan.metrics),
      };
      session.analysisFingerprint = selectedAnalysisFingerprint ?? null;
      session.plan = session.plan.map(item => {
        const sourcePlan = adaptivePlan.segments.find(value => value.id === item.segmentId);
        return sourcePlan?.reused
          ? { ...item, status: 'valid', reused: true, reusedFromSegmentId: sourcePlan.reusedFromSegmentId ?? sourcePlan.id, reusedFromSessionId: sourcePlan.reusedFromSessionId ?? null, projectedInputTokens: 0, expectedOutputTokens: 0, expectedAttempts: 0 }
          : { ...item, projectedInputTokens: sourcePlan?.projectedInputTokens ?? null, expectedOutputTokens: sourcePlan?.expectedOutputTokens ?? null, expectedAttempts: sourcePlan?.expectedAttempts ?? null, expectedWallTimeMs: sourcePlan?.expectedWallTimeMs ?? null, bundleCount: sourcePlan?.bundleCount ?? item.source?.turnBundles?.length ?? 0 };
      });
      session.segments = adaptivePlan.segments.filter(value => value.reused).map(value => structuredClone(value));
    }
    for (const item of session.plan) {
      if (item.status === 'valid') {
        item.minimumInputTokens = 0;
        item.essentialInputTokens = 0;
        continue;
      }
      item.minimumInputTokens = item.projectedInputTokens ?? await this.#targetOnlyInputTokens(item, counted);
      item.essentialInputTokens = Math.min(config.extraction.inputBudget, item.minimumInputTokens + (config.planner.mode === 'adaptive_balanced' ? config.extraction.continuityStateTokens : config.extraction.stateTokens));
    }
    session.report = { chatId: this.#chatId, sessionId: session.id, startedAt: new Date().toISOString(), completedAt: null, mode, processed: 0, valid: 0, failed: 0, retries: 0, outputs: [] };
    await this.#store.upsertRebuildSession(session);
    return this.#store.getRebuildSession(session.id);
  }

  async analyzeSegmentRegeneration(id) {
    await this.#ensureChat();
    const segment = this.#store.get(id);
    if (!segment) throw new Error(`Unknown segment: ${id}`);
    if (segment.manuallyEdited) throw new Error('Manually edited memory requires an explicit replacement workflow');
    const counted = await this.#countedHistory();
    if (!this.#sourceMatches(counted, segment)) throw new Error('Segment source changed; run integrity repair before regeneration');
    const plan = [{
      id: segment.id,
      source: structuredClone(segment.source),
      sourceTokenCount: segment.sourceTokenCount,
      boundaryReason: 'targeted_regeneration',
      oversized: Boolean(segment.oversized),
    }];
    const config = this.#rebuildConfig();
    const pricing = pricingSnapshot(this.#settings, config.model);
    return {
      segmentId: segment.id,
      firstIndex: segment.source.first.messageIndex,
      lastIndex: segment.source.last.messageIndex,
      estimatedRequests: normalizeGenerationMode(this.#settings.memoryGenerationMode) === 'live' ? 1 : 0,
      executionMode: normalizeGenerationMode(this.#settings.memoryGenerationMode),
      projection: normalizeGenerationMode(this.#settings.memoryGenerationMode) === 'live'
        ? await this.#projectRebuildUsage(plan, counted, pricing, config.extraction.totalInputBudget)
        : this.#noGenerationProjection(pricing, normalizeGenerationMode(this.#settings.memoryGenerationMode)),
    };
  }

  async startSegmentRegeneration(id) {
    await this.#ensureChat();
    const segment = this.#store.get(id);
    if (!segment) throw new Error(`Unknown segment: ${id}`);
    if (segment.manuallyEdited) throw new Error('Manually edited memory requires an explicit replacement workflow');
    const counted = await this.#countedHistory();
    if (!this.#sourceMatches(counted, segment)) throw new Error('Segment source changed; run integrity repair before regeneration');
    const config = this.#rebuildConfig();
    const target = {
      id: segment.id,
      firstIndex: segment.source.first.messageIndex,
      lastIndex: segment.source.last.messageIndex,
      source: structuredClone(segment.source),
      sourceTokenCount: segment.sourceTokenCount,
      boundaryReason: 'targeted_regeneration',
      oversized: Boolean(segment.oversized),
    };
    const session = structuredClone(createRebuildSession({
      chatId: this.#chatId,
      mode: 'targeted-regeneration',
      plan: [target],
      baselineSegments: this.#store.timeline(),
      config,
      pricing: pricingSnapshot(this.#settings, config.model),
    }));
    session.plan[0].minimumInputTokens = await this.#targetOnlyInputTokens(session.plan[0], counted);
    session.plan[0].essentialInputTokens = Math.min(config.extraction.inputBudget, session.plan[0].minimumInputTokens + config.extraction.stateTokens);
    session.report = { chatId: this.#chatId, sessionId: session.id, startedAt: new Date().toISOString(), completedAt: null, mode: session.mode, processed: 0, valid: 0, failed: 0, retries: 0, outputs: [] };
    await this.#store.upsertRebuildSession(session);
    return this.#store.getRebuildSession(session.id);
  }

  async regenerateSegment(id, options = {}) {
    const session = await this.startSegmentRegeneration(id);
    return this.resumeRebuild(session.id, { ...options, autoPromote: options.autoPromote ?? true });
  }

  async resumeRebuild(sessionId, options = {}) {
    const task = this.#claimMemoryOperation('rebuild', () => this.#resumeRebuild(sessionId, options));
    if (!task) {
      const error = new Error('A Mnemosyne memory operation is already running; wait for its boundary or inspect its status before retrying');
      error.code = 'memory_operation_busy';
      this.#metrics.record({ operation: 'memory_operation', status: 'busy', requested: 'rebuild', active: this.#memoryOperationKind });
      throw error;
    }
    return task;
  }

  async #resumeRebuild(sessionId, { onProgress = null, autoPromote = false, executionMode = null } = {}) {
    await this.#ensureChat();
    if (this.#backfillState.status === 'running') throw new Error('Backfill is already running');
    let session = this.#store.getRebuildSession(sessionId);
    if (!session) throw new Error(`Unknown rebuild session: ${sessionId}`);
    if (session.status === 'promoted') return { session, status: 'complete' };
    const counted = await this.#countedHistory();
    if (!this.#sessionConfigCompatible(session)) {
      await this.#archiveRebuildSession(session, counted, 'configuration_changed');
      throw new Error('Rebuild configuration changed; the previous session was archived and a new session is required');
    }
    if (!this.#sessionSourceMatches(session, counted)) {
      await this.#archiveRebuildSession(session, counted, 'source_changed');
      throw new Error('Chat source changed; this rebuild session was archived and cannot be resumed');
    }
    if (this.#refreshSessionSourceProvenance(session, counted)) await this.#store.upsertRebuildSession(session);
    const mode = normalizeGenerationMode(executionMode ?? this.#settings.memoryGenerationMode);
    const replaySource = mode === 'replay' ? await this.#loadReplaySource(session) : null;
    if (mode === 'offline' || (mode === 'replay' && !replaySource)) {
      return this.#stopWithoutGeneration(session, mode === 'offline' ? 'offline' : 'replay-missing', mode);
    }
    let planHydrated = false;
    for (const item of session.plan) {
      if (!Number.isFinite(item.minimumInputTokens)) {
        item.minimumInputTokens = await this.#targetOnlyInputTokens(item, counted);
        item.essentialInputTokens = Math.min(session.config.extraction.inputBudget, item.minimumInputTokens + (session.config.planner?.mode === 'adaptive_balanced' ? session.config.extraction.continuityStateTokens : session.config.extraction.stateTokens));
        planHydrated = true;
      }
    }
    if (planHydrated) await this.#store.upsertRebuildSession(session);
    session.status = 'running'; session.updatedAt = Date.now();
    await this.#store.upsertRebuildSession(session);
    const report = session.report ?? { chatId: this.#chatId, sessionId, startedAt: new Date().toISOString(), completedAt: null, mode: session.mode, processed: 0, valid: 0, failed: 0, retries: 0, outputs: [] };
    this.#backfillControl = { pauseRequested: false, cancelRequested: false };
      this.#backfillState = { status: 'running', analysis: await this.analyzeBackfill({ sessionId, executionMode: mode }), report: structuredClone(report) };
    this.#generationState = { ...this.#generationState, mode, operation: 'running', totalSegments: session.plan.length, currentSegmentId: null, currentSegmentOrdinal: null, requestStartedAt: null, lastError: null };
    while (true) {
      if (this.#backfillControl.cancelRequested || this.#backfillControl.pauseRequested) break;
      const target = session.plan.find(item => item.status !== 'valid');
      if (!target) break;
      if (mode === 'replay' && !replaySource.hasNext(target.segmentId)) {
        return this.#stopWithoutGeneration(session, 'replay-missing', mode, report);
      }
      const targetOrdinal = session.plan.findIndex(item => item.segmentId === target.segmentId) + 1;
      this.#generationState = { ...this.#generationState, mode, operation: mode === 'replay' ? 'replay' : 'generating', currentSegmentId: target.segmentId, currentSegmentOrdinal: targetOrdinal, totalSegments: session.plan.length, requestStartedAt: Date.now(), lastError: null };
      let result;
      try {
        result = mode === 'replay'
          ? await this.#extractRebuildTarget(session, target, counted, { executionMode: mode, replaySource })
          : await this.#recoverRebuildTargetLocally(session, target)
            ?? await this.#extractRebuildTarget(session, target, counted, { executionMode: mode, replaySource });
      } catch (error) {
        session.status = 'incomplete';
        session.updatedAt = Date.now();
        report.completedAt = new Date().toISOString();
        report.interruption = { code: error?.code ?? 'unexpected_error', message: String(error?.message ?? error) };
        session.report = structuredClone(report);
        try { await this.#store.upsertRebuildSession(session); } catch {}
        this.#generationState = { ...this.#generationState, mode, operation: 'stopped-on-failure', currentSegmentId: target.segmentId, requestStartedAt: null, lastError: error?.code ?? String(error?.message ?? error) };
        this.#backfillState = { status: error?.code === 'replay_missing' ? 'replay-missing' : 'stopped-on-failure', analysis: await this.analyzeBackfill({ sessionId, executionMode: mode }), report: structuredClone(report) };
        throw error;
      }
      session = result.session;
      report.processed += 1;
      report.retries += result.result.retries;
      report[result.result.segment.status === 'valid' ? 'valid' : 'failed'] += 1;
      report.outputs.push({ segmentId: result.result.segment.id, source: { firstIndex: result.result.segment.source.first.messageIndex, lastIndex: result.result.segment.source.last.messageIndex, rangeFingerprint: result.result.segment.source.rangeFingerprint }, sourceTokenCount: result.result.segment.sourceTokenCount, status: result.result.segment.status, summary: result.result.segment.summary ? structuredClone(result.result.segment.summary) : null, extraction: structuredClone(result.result.segment.extraction ?? null) });
      session.report = structuredClone(report); session.updatedAt = Date.now();
      await this.#store.upsertRebuildSession(session);
      this.#generationState = { ...this.#generationState, mode, operation: 'waiting', currentSegmentId: null, currentSegmentOrdinal: targetOrdinal, totalSegments: session.plan.length, requestStartedAt: null, lastError: result.result.segment.status === 'valid' ? null : (result.result.segment.extraction?.failure ?? 'segment_failed') };
      this.#backfillState = { status: 'running', analysis: await this.analyzeBackfill({ sessionId, executionMode: mode }), report: structuredClone(report) };
      await onProgress?.(this.backfillStatus());
      if (result.result.segment.status === 'failed') break;
    }
    const allValid = session.plan.every(item => item.status === 'valid');
    const runtimeStatus = this.#backfillControl.cancelRequested ? 'cancelled' : this.#backfillControl.pauseRequested ? 'paused' : allValid ? 'complete' : 'stopped-on-failure';
    session.status = allValid ? 'complete' : 'incomplete'; session.updatedAt = Date.now();
    report.completedAt = runtimeStatus === 'paused' ? null : new Date().toISOString();
    report.cost = aggregateAttemptCosts(session.attempts);
    session.report = structuredClone(report);
    await this.#store.upsertRebuildSession(session);
    if (allValid && autoPromote) session = await this.promoteRebuild(session.id);
    this.#backfillState = { status: runtimeStatus, analysis: await this.analyzeBackfill({ sessionId: session.id, executionMode: mode }), report: structuredClone(report) };
    this.#generationState = { ...this.#generationState, mode, operation: runtimeStatus === 'complete' ? 'idle' : runtimeStatus, currentSegmentId: null, currentSegmentOrdinal: allValid ? session.plan.length : this.#generationState.currentSegmentOrdinal, totalSegments: session.plan.length, requestStartedAt: null, lastError: runtimeStatus === 'stopped-on-failure' ? 'segment_failed' : null };
    return { session: structuredClone(session), ...this.backfillStatus() };
  }

  async runBackfill({ rebuild = false, retryFailed = false, onProgress = null, executionMode = null, analysisFingerprint = null, planCandidateId = null } = {}) {
    await this.#ensureChat();
    let session = !rebuild ? this.#latestResumableSession() : null;
    if (session) {
      const counted = await this.#countedHistory();
      if (!this.#sessionSourceMatches(session, counted)) {
        await this.#archiveRebuildSession(session, counted, 'source_changed');
        session = null;
      }
    }
    if (!session) session = await this.startRebuild({ mode: rebuild ? 'rebuild' : 'fill-missing', analysisFingerprint, planCandidateId });
    return this.resumeRebuild(session.id, { onProgress, autoPromote: true, executionMode });
  }

  async replayRebuild(sessionId, options = {}) {
    return this.resumeRebuild(sessionId, { ...options, executionMode: 'replay', autoPromote: options.autoPromote ?? false });
  }

  getRebuildSession(id) { return this.#store?.getRebuildSession(id) ?? null; }

  async importRebuildSession(serialized) {
    await this.#ensureChat();
    const artifact = normalizeReplayArtifact(serialized, { expectedChatId: this.#chatId });
    const sourceMessages = this.#context.sourceMessages();
    if (!this.#sessionSourceMatches(artifact.session, sourceMessages)) throw new ReplayArtifactError('Replay session source does not match the active chat', 'replay_source_mismatch');
    if (!this.#sessionConfigCompatible(artifact.session)) throw new ReplayArtifactError('Replay session configuration does not match the current settings', 'replay_config_mismatch');
    const existing = this.#store.getRebuildSession(artifact.session.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(artifact.session)) throw new ReplayArtifactError('A different rebuild session with this id is already stored', 'replay_session_conflict');
    await this.#attemptStore?.importRebuildAttempts(this.#chatId, artifact.session.id, artifact.rawAttempts);
    await this.#store.upsertRebuildSession(artifact.session);
    const replaySource = await this.#loadReplaySource(artifact.session);
    this.#generationState = {
      ...this.#generationState,
      mode: normalizeGenerationMode(this.#settings.memoryGenerationMode),
      replaySessionId: artifact.session.id,
      availableSegmentCount: replaySource?.status().availableSegmentIds.length ?? 0,
      missingSegmentCount: replaySource?.status().missingSegmentIds.length ?? artifact.session.plan.length,
      availableAttemptCount: replaySource?.status().availableAttemptCount ?? 0,
      lastError: null,
    };
    return this.#store.getRebuildSession(artifact.session.id);
  }

  async exportRebuildSession(id) {
    await this.#ensureChat();
    const session = this.#store.getRebuildSession(id);
    if (!session) throw new Error(`Unknown rebuild session: ${id}`);
    const rawAttempts = this.#attemptStore ? await this.#attemptStore.exportRebuildAttempts(this.#chatId, id) : [];
    return JSON.stringify({ version: 2, session, rawAttempts }, null, 2);
  }

  async deleteRebuildSession(id) {
    await this.#ensureChat();
    const session = this.#store.getRebuildSession(id);
    if (!session) return false;
    await this.#attemptStore?.deleteRebuildAttempts(this.#chatId, id);
    return this.#store.deleteRebuildSession(id);
  }

  async retireCommitment(segmentId, commitmentIndexOrId) {
    await this.#ensureChat();
    const segment = await this.#store.retireCommitment(segmentId, commitmentIndexOrId);
    await this.#rebuildLexical(this.#activeSegments(this.#context.sourceMessages(), this.#store.timeline({ includeExcluded: false })));
    this.#metrics.record({
      operation: 'commitment_retirement',
      status: 'success',
      segmentId,
      commitmentIndex: typeof commitmentIndexOrId === 'number' || (typeof commitmentIndexOrId === 'string' && /^\d+$/.test(commitmentIndexOrId.trim())) ? Number(commitmentIndexOrId) : null,
      commitmentId: typeof commitmentIndexOrId === 'number' || (typeof commitmentIndexOrId === 'string' && /^\d+$/.test(commitmentIndexOrId.trim())) ? null : String(commitmentIndexOrId),
      sourceFingerprint: segment.source?.rangeFingerprint ?? null,
    });
    return segment;
  }

  async promoteRebuild(id) {
    await this.#ensureChat();
    const session = this.#store.getRebuildSession(id);
    if (!session || !['complete', 'promoted'].includes(session.status)) throw new Error('Only a complete rebuild session can be promoted');
    const sourceMessages = this.#context.sourceMessages();
    if (!this.#sessionSourceMatches(session, sourceMessages)) throw new Error('Rebuild source changed before promotion');
    if (baselineFingerprint(this.#store.timeline()) !== session.baselineFingerprint) throw new Error('Active baseline changed before promotion');
    const candidates = session.segments.filter(segment => segment.status === 'valid');
    if (candidates.length !== session.plan.length || candidates.some(segment => !this.#sourceMatches(sourceMessages, segment))) throw new Error('Candidate coverage is incomplete or stale');
    const covered = new Set(session.plan.flatMap(item => Array.from({ length: item.source.last.messageIndex - item.source.first.messageIndex + 1 }, (_, offset) => item.source.first.messageIndex + offset)));
    const preserved = this.#store.timeline().filter(segment => segment.manuallyEdited || segment.status === 'excluded' || !Array.from({ length: segment.source.last.messageIndex - segment.source.first.messageIndex + 1 }, (_, offset) => segment.source.first.messageIndex + offset).some(index => covered.has(index)));
    const protectedIndices = new Set(preserved.filter(segment => segment.manuallyEdited || segment.status === 'excluded').flatMap(segment => Array.from({ length: segment.source.last.messageIndex - segment.source.first.messageIndex + 1 }, (_, offset) => segment.source.first.messageIndex + offset)));
    const promotableCandidates = candidates.filter(segment => !Array.from({ length: segment.source.last.messageIndex - segment.source.first.messageIndex + 1 }, (_, offset) => segment.source.first.messageIndex + offset).some(index => protectedIndices.has(index)));
    const merged = [...preserved, ...promotableCandidates].sort((a, b) => a.source.first.messageIndex - b.source.first.messageIndex);
    const promoted = { ...session, status: 'promoted', promotedAt: Date.now(), updatedAt: Date.now() };
    const envelope = this.#store.snapshot();
    envelope.segments = merged;
    envelope.entities = materializeEntities(merged, { contextKey: this.#chatId, existing: envelope.entities ?? [] });
    envelope.registers = materializeRegisters(merged);
    envelope.rebuildSessions = envelope.rebuildSessions.map(value => value.id === id ? promoted : value);
    await this.#store.replaceEnvelope(envelope);
    await this.#rebuildLexical(activeInjectableSegments(merged));
    return this.#store.getRebuildSession(id);
  }

  pauseBackfill() {
    if (this.#backfillState.status !== 'running') return false;
    this.#backfillControl.pauseRequested = true;
    return true;
  }

  cancelBackfill() {
    if (!['running', 'paused'].includes(this.#backfillState.status)) return false;
    this.#backfillControl.cancelRequested = true;
    if (this.#backfillState.status === 'paused') this.#backfillState = { ...this.#backfillState, status: 'cancelled', report: { ...this.#backfillState.report, completedAt: new Date().toISOString() } };
    return true;
  }

  async rebuildIndexes() {
    const segments = this.#activeSegments(this.#context.sourceMessages(), this.#store?.timeline({ includeExcluded: false }) ?? []);
    const result = await this.#rebuildLexical(segments);
    if (this.#store) await this.#refreshMaterialized();
    return result;
  }

  async rebuildAllDerived() {
    const manualPreserved = this.#store?.timeline().filter(segment => segment.manuallyEdited).length ?? 0;
    const state = await this.runBackfill({ rebuild: true });
    return { processed: state.report.processed, manualPreserved, status: state.status };
  }

  async intercept(generationChat, contextSize, generationType = 'normal') {
    const criticalStarted = performance.now();
    // A new prompt is the only authoritative answer to whether a message was
    // omitted. Clear the previous observation while this prompt is rebuilt so
    // the visual state cannot claim that an old generation still describes
    // the current chat.
    this.#lastCompiled = null;
    if (!this.#enabled) {
      this.#context.clearContextInjection();
      return null;
    }
    if (this.#settings.injectManagedMemory === false) {
      this.#context.clearContextInjection();
      this.#metrics.record({ operation: 'generation_critical_path', status: 'injection_disabled', generationType, durationMs: performance.now() - criticalStarted });
      return null;
    }
    if (['quiet', 'silent'].includes(String(generationType).toLowerCase()) && this.#settings.injectIntoQuietGenerations !== true) {
      this.#context.clearContextInjection();
      this.#metrics.record({ operation: 'generation_critical_path', status: 'skipped_generation_type', generationType, durationMs: performance.now() - criticalStarted });
      return null;
    }
    await this.#ensureChat();
    const sourceMessages = this.#context.sourceMessages();
    await this.#auditStoredIntegrity(sourceMessages);
    const counted = await this.#countMessages(sourceMessages);
    const raw = planRawForeground(counted, { budgetTokens: this.#rawForegroundBudget(), metrics: this.#metrics });
    const usable = this.#activeSegments(sourceMessages, this.#store.timeline({ includeExcluded: false }));
    const materializedEntities = this.#store.snapshot().entities ?? [];

    const stateStarted = performance.now();
    const rawFirst = raw.firstIndex ?? sourceMessages.length;
    const beforeRaw = usable.filter(segment => (segment.source?.last?.messageIndex ?? Infinity) < rawFirst);
    const replay = await this.#replayWithCheckpoint(beforeRaw);
    const projectedReplay = this.#ageOutCommitments(replay.state, beforeRaw, 'generation');
    const stateProjectionMs = performance.now() - stateStarted;
    const chronological = beforeRaw.slice(-8);
    const chronologicalIds = new Set(chronological.map(segment => segment.id));
    const older = beforeRaw.filter(segment => !chronologicalIds.has(segment.id));
    const currentUserMessage = [...counted].reverse().find(message => message.role === 'user')?.text ?? '';
    const rawMessages = counted.filter(message => raw.indices.includes(message.index));
    const availableGroupParticipants = collectGroupParticipants(sourceMessages);
    const selectedGroupParticipants = selectGroupParticipants(availableGroupParticipants, this.#settings.memoryGroupParticipantNames);
    const activeSpeakerName = this.#context.activeCharacterName?.()
      ?? [...rawMessages].reverse().find(message => message.role === 'assistant')?.name
      ?? null;
    const foregroundNames = new Set([...rawMessages.map(message => message.name), ...selectedGroupParticipants, activeSpeakerName].map(normalizeAlias).filter(Boolean));
    const activeEntities = materializedEntities.filter(entity => [entity.canonicalName, ...(entity.aliases ?? []).map(alias => alias.value ?? alias)]
      .some(name => foregroundNames.has(normalizeAlias(name))));
    const activeSpeakerEntityId = activeSpeakerName
      ? activeEntities.find(entity => [entity.canonicalName, ...(entity.aliases ?? []).map(alias => alias.value ?? alias)].some(name => normalizeAlias(name) === normalizeAlias(activeSpeakerName)))?.id ?? null
      : null;
    const materializedRegisters = this.#store.snapshot().registers ?? [];
    const rawQueryText = [currentUserMessage, ...counted.filter(message => raw.indices.includes(message.index)).map(message => message.text)].join('\n');
    const directRegisterKeys = directlyRelevantRegisterKeys(materializedRegisters, rawQueryText);
    const query = await this.#queryBuilder.build({
      currentUserMessage,
      rawTail: counted.filter(message => raw.indices.includes(message.index)),
      activeThreads: Object.values(projectedReplay.state.threads ?? {}),
      activeCommitments: Object.values(projectedReplay.state.commitments ?? {}),
      activeRegisters: directRegisterKeys,
      entities: activeEntities,
      activeEntityIds: activeEntities.map(entity => entity.id),
      participantEntityIds: activeEntities.map(entity => entity.id),
      activeSpeakerEntityId,
    });
    const indexDocuments = new Map(this.#lexical.serialize().map(document => [document.id, document]));
    const retrievalStarted = performance.now();
    const retrieval = older.length ? await this.#retriever.retrieve(query, older.map(segment => ({ id: segment.id, fingerprint: segment.source.rangeFingerprint, text: segment.summary.synopsis, document: indexDocuments.get(segment.id) })), { limit: 8 }) : [];
    const retrievalMs = performance.now() - retrievalStarted;
    this.#lastRetrieval = retrieval;
    const retrievedRegisterKeys = retrieval.flatMap(result => indexDocuments.get(result.id)?.registers ?? []);
    const registerProjection = projectRegisters(materializedRegisters, { relevantKeys: [...new Set([...directRegisterKeys, ...retrievedRegisterKeys])] });
    const segmentById = new Map(older.map(segment => [segment.id, segment]));
    const associative = retrieval.map(result => ({ ...result, artifact: segmentById.get(result.id) }));
    const maximumPromptTokens = Math.max(1, Number(contextSize) || Number(this.#settings.contextBudget) || 12_000);
    const configuredReserve = Math.max(0, Number(this.#settings.contextReserveTokens) || 0);
    const publicPromptTokenBreakdown = await this.#context.publicPromptTokenBreakdown?.();
    const externalPromptBudget = await measureExternalPromptBudget({
      extensionPrompts: this.#context.extensionPromptEntries?.() ?? this.#context.context().extensionPrompts,
      countTokens: text => this.#context.countTokens(text),
      excludedKeys: [PROMPT_KEY],
      configuredReserve,
      maximumPromptTokens,
      publicBreakdown: publicPromptTokenBreakdown,
    });
    this.#metrics.record({
      operation: 'external_prompt_budget',
      status: externalPromptBudget.registryAvailable ? 'measured_public_registry' : 'reserve_only',
      measuredTokens: externalPromptBudget.measuredTokens,
      measuredEntryCount: externalPromptBudget.measuredEntryCount,
      skippedEntryCount: externalPromptBudget.skippedEntryCount,
      fallbackEntryCount: externalPromptBudget.fallbackEntryCount,
      configuredReserve: externalPromptBudget.configuredReserve,
      effectiveReserve: externalPromptBudget.effectiveReserve,
      maximumPromptTokens,
      coverage: externalPromptBudget.coverage,
      exactPublicBreakdown: externalPromptBudget.exactFinalPromptItemization,
      publicBreakdownEntryCount: externalPromptBudget.publicBreakdown?.entries?.length ?? 0,
      publicBreakdownSource: externalPromptBudget.publicBreakdown?.source ?? null,
    });
    const effectiveReserve = externalPromptBudget.effectiveReserve;
    const hardTotal = Math.max(1, Math.min(maximumPromptTokens - effectiveReserve, Number(this.#settings.contextBudget) || 12_000));
    const compiled = await this.#compiler.compile({
      state: beforeRaw.length ? projectNarrativeState(projectedReplay.state, { entityRecords: materializedEntities, segments: beforeRaw, commitmentAgeOutSegments: 0 }) : [],
      registers: registerProjection,
      chronological,
      associative,
      replacementSegments: beforeRaw,
      rawMessages: counted.filter(message => raw.indices.includes(message.index)).map(message => ({ ...message, required: message.role === 'user' })),
    }, {
      hardTotal,
      raw: this.#rawForegroundBudget(hardTotal),
      state: Math.min(nonNegativeSetting(this.#settings, 'contextStateBudget', 800), hardTotal),
      registers: Math.min(nonNegativeSetting(this.#settings, 'contextRegistersBudget', 300), hardTotal),
      chronological: Math.min(nonNegativeSetting(this.#settings, 'contextChronologicalBudget', 2_500), hardTotal),
      associative: Math.min(nonNegativeSetting(this.#settings, 'contextAssociativeBudget', 1_500), hardTotal),
    });
    const virtualizationStarted = performance.now();
    const virtualization = applyPromptVirtualization(generationChat, compiled, { ignoreSymbol: this.#context.ignoreSymbol(), setInjection: (value, options) => this.#context.setContextInjection(value, options) });
    const promptVirtualizationMs = performance.now() - virtualizationStarted;
    this.#lastCompiled = {
      ...compiled,
      injection: virtualization.injection,
      maximumPromptTokens,
      contextReserveTokens: effectiveReserve,
      configuredContextReserveTokens: configuredReserve,
      externalPromptBudget,
      budgetSource: externalPromptBudget.budgetSource,
      observedAt: Date.now(),
    };
    this.#metrics.record({ operation: 'generation_critical_path', status: 'success', generationType, durationMs: performance.now() - criticalStarted, stateProjectionMs, retrievalMs, promptVirtualizationMs, totalManagedTokens: compiled.totalTokens });
    this.#rememberActiveBranches(sourceMessages, usable);
    return compiled;
  }

  async handleEvent(event) {
    if (event.kind === 'chatChanged') {
      if (this.#chatId) this.#jobs.cancelChat(this.#chatId);
      this.#compactionAbortController?.abort(new DOMException('Chat changed', 'AbortError'));
      this.#autoCompactionChatId = null;
      this.#chatId = null;
      this.#store = null;
      this.#lastCompiled = null;
      this.#receivedSinceIntegrityAudit = 0;
      this.#generationState = { ...this.#generationState, operation: 'idle', replaySessionId: null, availableSegmentCount: 0, missingSegmentCount: 0, availableAttemptCount: 0, currentSegmentId: null, currentSegmentOrdinal: null, totalSegments: null, requestStartedAt: null, lastError: null };
      await this.#ensureChat();
      if (this.#enabled && this.#settings.autoCompact !== false) {
        void this.scheduleCompactionOnChatOpen().catch(error => {
          this.#metrics.record({ operation: 'compaction_schedule', status: 'failed', trigger: 'chat_open', errorName: error?.name ?? 'Error' });
        });
      }
      return;
    }
    if (event.kind === 'received') {
      let auditFailed = false;
      if (this.#enabled) {
        this.#receivedSinceIntegrityAudit += 1;
        const interval = Math.floor(nonNegativeSetting(this.#settings, 'integrityAuditIntervalMessages', 5));
        if (interval > 0 && this.#receivedSinceIntegrityAudit >= interval) {
          this.#receivedSinceIntegrityAudit = 0;
          try {
            await this.#ensureChat();
            await this.#auditStoredIntegrity(this.#context.sourceMessages());
          } catch (error) {
            auditFailed = true;
            this.#metrics.record({ operation: 'integrity_periodic_audit', status: 'failed', errorName: error?.name ?? 'Error' });
          }
        }
      }
      if (!auditFailed && this.#enabled && this.#settings.autoCompact !== false) void this.scheduleCompaction();
      return;
    }
    if (!['edited', 'deleted', 'swiped'].includes(event.kind) || !Number.isInteger(event.messageIndex)) return;
    this.#lastCompiled = null;
    await this.#ensureChat();
    const segments = this.#store.timeline();
    let result;
    if (event.kind === 'edited') result = this.#mutations.handleEdit(segments, event.messageIndex);
    if (event.kind === 'deleted') result = this.#mutations.handleDelete(segments, event.messageIndex);
    if (event.kind === 'swiped') {
      const source = this.#context.sourceMessages()[event.messageIndex];
      const activeFingerprint = source ? createMessageSourceRef(source, event.messageIndex).messageFingerprint : 'missing';
      result = this.#mutations.handleSwipe(segments, { messageIndex: event.messageIndex, activeFingerprint });
    }
    await this.#store.replaceSegments(result.segments);
    await this.#rebuildLexical(activeInjectableSegments(result.segments));
  }

  scheduleCompaction(options = {}) {
    if (!this.#enabled) return Promise.resolve(null);
    if (this.#compactionPromise) return this.#compactionPromise;
    const task = this.#claimMemoryOperation('compaction', () => this.#runCompaction(options));
    if (!task) {
      this.#metrics.record({ operation: 'compaction_schedule', status: 'busy', active: this.#memoryOperationKind });
      return Promise.resolve(null);
    }
    this.#compactionPromise = task;
    const clear = () => { if (this.#compactionPromise === task) this.#compactionPromise = null; };
    void task.then(clear, clear);
    return this.#compactionPromise;
  }

  /**
   * Run one bounded compaction check when a chat is opened. This intentionally
   * does not become a historical rebuild: one eligible segment is processed,
   * while later messages continue through the ordinary received-event queue.
   * Failed ranges remain an explicit retry boundary.
   */
  async scheduleCompactionOnChatOpen() {
    await this.#ensureChat();
    if (!this.#enabled || this.#settings.autoCompact === false || !this.#chatId) return null;
    if (this.#autoCompactionChatId === this.#chatId) return null;
    const chatId = this.#chatId;
    this.#autoCompactionChatId = chatId;
    try {
      await this.#auditStoredIntegrity(this.#context.sourceMessages());
    } catch (error) {
      this.#metrics.record({ operation: 'integrity_open_audit', status: 'failed', errorName: error?.name ?? 'Error' });
      return null;
    }
    const inFlight = this.#compactionPromise;
    if (inFlight) {
      try { await inFlight; } catch { /* the failed flight remains journaled */ }
      if (this.#chatId !== chatId) return null;
    }
    return this.scheduleCompaction({ force: true, trigger: 'chat_open' });
  }

  #claimMemoryOperation(kind, operation) {
    if (this.#memoryOperationPromise) return null;
    const task = Promise.resolve().then(operation);
    this.#memoryOperationPromise = task;
    this.#memoryOperationKind = String(kind);
    const clear = () => {
      if (this.#memoryOperationPromise !== task) return;
      this.#memoryOperationPromise = null;
      this.#memoryOperationKind = null;
    };
    // Attach a rejection handler to the cleanup branch so the original task's
    // rejection remains observable to its caller without creating an
    // unhandled rejection from the bookkeeping promise.
    void task.then(clear, clear);
    return task;
  }

  async #runCompaction({ force = false, retryFailed = false, trigger = 'automatic' } = {}) {
    if (!this.#enabled) return null;
    await this.#ensureChat();
    const generationMode = normalizeGenerationMode(this.#settings.memoryGenerationMode);
    if (generationMode !== 'live') {
      this.#generationState = { ...this.#generationState, mode: generationMode, lastError: null };
      this.#metrics.record({ operation: 'compaction_schedule', status: generationMode === 'replay' ? 'replay_requires_explicit_session' : 'offline_raw_only', eligibleMessageCount: 0, extractionCalls: 0, executionMode: generationMode });
      return null;
    }
    const scheduledChatId = this.#chatId;
    const sourceMessages = this.#context.sourceMessages();
    const counted = await this.#countMessages(sourceMessages);
    const narrative = counted.filter(message => shouldIncludeMessage(message));
    const raw = planRawForeground(counted, { budgetTokens: this.#rawForegroundBudget(), metrics: this.#metrics });
    const frontier = computeCompactionFrontier(narrative, raw, { preemptiveRatio: Number(this.#settings.preemptiveRatio) || 0.85 });
    if (frontier.eligibleMessageCount === 0 || (!force && !frontier.shouldSchedule)) {
      this.#metrics.record({ operation: 'compaction_schedule', status: 'not_needed', trigger, eligibleMessageCount: frontier.eligibleMessageCount, extractionCalls: 0 });
      return null;
    }
    const existing = this.#store.timeline();
    const matching = existing.filter(segment => this.#sourceMatches(sourceMessages, segment));
    const blockers = matching.filter(segment => ['failed', 'stale'].includes(segment.status));
    const firstBlocked = blockers.reduce((first, segment) => {
      if (segment.source.first.messageIndex < first.index) return { index: segment.source.first.messageIndex, status: segment.status };
      return first;
    }, { index: Infinity, status: null });
    const effectiveEligibleThroughIndex = retryFailed || !Number.isFinite(firstBlocked.index)
      ? frontier.eligibleThroughIndex
      : Math.min(frontier.eligibleThroughIndex, firstBlocked.index - 1);
    const effectiveEligibleMessageCount = narrative.filter(message => message.index <= effectiveEligibleThroughIndex).length;
    if (!retryFailed && Number.isFinite(firstBlocked.index) && firstBlocked.index <= frontier.eligibleThroughIndex && effectiveEligibleMessageCount === 0) {
      this.#metrics.record({ operation: 'compaction_schedule', status: firstBlocked.status === 'stale' ? 'blocked_on_stale' : 'blocked_on_failure', trigger, blockedSegmentCount: blockers.length, blockedStatus: firstBlocked.status, firstBlockedIndex: firstBlocked.index, eligibleMessageCount: frontier.eligibleMessageCount, extractionCalls: 0 });
      return null;
    }
    const covered = new Set();
    for (const segment of matching.filter(segment => ['valid', 'pending', 'excluded'].includes(segment.status))) {
      for (let index = segment.source.first.messageIndex; index <= segment.source.last.messageIndex; index += 1) covered.add(index);
    }
    const firstUncovered = narrative.find(message => message.index <= effectiveEligibleThroughIndex && !covered.has(message.index))?.index;
    const eligible = [];
    if (Number.isInteger(firstUncovered)) {
      for (let index = firstUncovered; index <= effectiveEligibleThroughIndex && !covered.has(index); index += 1) {
        const message = narrative.find(item => item.index === index);
        if (!message) break;
        eligible.push(message);
      }
    }
    if (!eligible.length) {
      this.#metrics.record({ operation: 'compaction_schedule', status: Number.isFinite(firstBlocked.index) && !retryFailed ? (firstBlocked.status === 'stale' ? 'blocked_on_stale' : 'blocked_on_failure') : 'already_covered', trigger, eligibleMessageCount: 0, extractionCalls: 0 });
      return null;
    }
    const planned = planSegments(eligible, {
      targetTokens: Number(this.#settings.segmentTarget) || 5_000,
      softMaxTokens: Number(this.#settings.segmentSoftMax) || 7_000,
      hardMaxTokens: Number(this.#settings.segmentHardMax) || 9_000,
      atomicTurns: true,
      metrics: this.#metrics,
    });
    const target = planned[0];
    const now = Date.now();
    const priorActive = this.#activeSegments(sourceMessages, existing).filter(segment => segment.source.last.messageIndex < target.firstIndex);
    const pending = {
      ...target, dependencyIds: priorActive.map(segment => segment.id), summary: null,
      status: 'pending', createdAt: now, updatedAt: now, schemaVersion: 1, promptVersion: 1, manuallyEdited: false, pinned: false,
    };
    const replay = new ReplayEngine({ metrics: this.#metrics }).replay(priorActive);
    const stateAtStart = await this.#packExtractionState(replay.state, 1_200, { entityRecords: this.#store.snapshot().entities ?? [], segments: priorActive });
    const historical = priorActive.map(segment => ({ ...segment, tokenCount: Math.max(1, Math.ceil(segment.sourceTokenCount / 5)) }));
    const compiledRequest = compileExtractionRequest({
      target: { ...target, messages: eligible.filter(message => message.index >= target.firstIndex && message.index <= target.lastIndex) },
      stateAtStart,
      previousSummaries: historical.slice(-8), olderMemories: historical.slice(0, -8),
      rawPrelude: counted.filter(message => message.index < target.firstIndex).slice(-8),
    });
    const request = { ...compiledRequest, estimatedInputTokens: await this.#context.countTokens(renderedProviderInput(compiledRequest)) };
    const token = this.#jobs.begin({ jobId: target.id, chatId: scheduledChatId, sourceFingerprint: target.source.rangeFingerprint });
    try {
      await this.#store.commitSegment(pending);
    } catch (error) {
      // A pending marker is only useful when it is durable. Release the local
      // job guard immediately if metadata persistence fails so a later,
      // explicit compaction can retry instead of leaving the chat wedged.
      this.#jobs.finish(token);
      this.#metrics.record({ operation: 'compaction_persistence', status: 'failed_before_request', errorName: error?.name ?? 'Error' });
      throw error;
    }
    this.#generationState = { ...this.#generationState, mode: 'live', operation: 'compaction', currentSegmentId: target.id, currentSegmentOrdinal: 1, totalSegments: planned.length, requestStartedAt: Date.now(), lastError: null };
    const generationAdapter = this.#tokenGuard.wrap(new MemoryGenerationAdapter({
      getContext: () => this.#context.context(),
      metrics: this.#metrics,
      logger: this.#logger,
      cooldownMs: this.#settings.memoryCooldownMs,
      temperature: this.#settings.memoryTemperature,
      topP: this.#settings.memoryTopP,
    }));
    const engine = new ExtractionEngine({
      generationAdapter, metrics: this.#metrics, logger: this.#logger,
      commit: async valid => {
        if (!this.#canCommitJob(token, target)) return;
        await this.#store.commitSegment(valid);
        await this.#refreshMaterialized();
        await this.#rebuildLexical(activeInjectableSegments(this.#store.timeline({ includeExcluded: false })));
      },
    });
    this.#compactionAbortController = new AbortController();
    const onAttempt = async payload => {
      if (!this.#attemptStore?.putCompactionAttempt) throw new Error('Durable compaction attempt storage is unavailable');
      const stored = await this.#attemptStore.putCompactionAttempt(scheduledChatId, target.id, payload.attempt, {
        ...structuredClone(payload),
        sourceFingerprint: target.source.rangeFingerprint,
        request: {
          promptVersion: request.promptVersion,
          estimatedInputTokens: request.estimatedInputTokens ?? null,
          maxOutputTokens: Number(this.#settings.extractionMaxOutputTokens) || 4_000,
        },
      });
      return stored.ref;
    };
    let result;
    try {
      result = await engine.extract({
        segment: pending, request, profileId: this.#settings.memoryConnectionProfileId,
        maxRetries: Math.max(0, Number(this.#settings.memoryExtractionRetries) || 0),
        preferFallback: Boolean(this.#settings.preferFallbackExtraction),
        entityContextKey: scheduledChatId, knownEntities: this.#store.snapshot().entities ?? [],
        maxTokens: Number(this.#settings.extractionMaxOutputTokens) || 4_000,
        onAttempt,
        signal: this.#compactionAbortController.signal,
      });
      if (!result.committed && result.segment.status === 'failed' && this.#canCommitJob(token, target)) await this.#store.commitSegment(result.segment);
    } finally {
      this.#jobs.finish(token);
      this.#compactionAbortController = null;
      this.#generationState = { ...this.#generationState, mode: 'live', operation: 'idle', currentSegmentId: null, currentSegmentOrdinal: null, totalSegments: null, requestStartedAt: null };
    }
    this.#metrics.record({ operation: 'compaction_schedule', status: result.segment.status, trigger, retryFailed, eligibleMessageCount: eligible.length, extractionCalls: 1 + result.retries });
    return result;
  }

  #rawForegroundBudget(hardTotal = null) {
    const configured = Math.max(1, Number(this.#settings.rawTailBudget) || 4_000);
    const hard = Math.max(1, Number(hardTotal) || Number(this.#settings.contextBudget) || 12_000);
    const budgets = allocateContextBudgets({
      hardTotal: hard,
      raw: configured,
      state: nonNegativeSetting(this.#settings, 'contextStateBudget', 800),
      registers: nonNegativeSetting(this.#settings, 'contextRegistersBudget', 300),
      chronological: nonNegativeSetting(this.#settings, 'contextChronologicalBudget', 2_500),
      associative: nonNegativeSetting(this.#settings, 'contextAssociativeBudget', 1_500),
    });
    const effective = Math.max(1, Math.floor(budgets.raw));
    if (effective !== configured) {
      this.#metrics.record({
        operation: 'raw_foreground_budget',
        status: 'capped_for_semantic_reserve',
        configuredTokens: configured,
        effectiveTokens: effective,
        hardBudgetTokens: hard,
        semanticReserveTokens: Math.max(0, hard - effective),
      });
    }
    return effective;
  }

  async #countedHistory() {
    return this.#countMessages(this.#context.sourceMessages());
  }

  #planUncovered(counted, eligibleThroughIndex, existing, { retryFailed = false } = {}) {
    const covered = new Set();
    const coveredStatuses = retryFailed ? new Set(['valid', 'pending', 'excluded']) : new Set(['valid', 'pending', 'failed', 'excluded']);
    for (const segment of existing.filter(segment => coveredStatuses.has(segment.status) && this.#sourceMatches(counted, segment))) {
      for (let index = segment.source.first.messageIndex; index <= segment.source.last.messageIndex; index += 1) covered.add(index);
    }
    const ranges = [];
    let current = [];
    for (const message of counted.filter(message => shouldIncludeMessage(message) && message.index <= eligibleThroughIndex)) {
      const gap = current.length && message.index !== current.at(-1).index + 1;
      if (covered.has(message.index) || gap) {
        if (current.length) ranges.push(current);
        current = [];
      }
      if (!covered.has(message.index)) current.push(message);
    }
    if (current.length) ranges.push(current);
    const options = { ...this.#segmentBudgets(), atomicTurns: true };
    return { ranges, segments: ranges.flatMap(range => planSegments(range, options)) };
  }

  #segmentBudgets() {
    return { targetTokens: Number(this.#settings.segmentTarget) || 5_000, softMaxTokens: Number(this.#settings.segmentSoftMax) || 7_000, hardMaxTokens: Number(this.#settings.segmentHardMax) || 9_000 };
  }

  #plannerMode() {
    const configured = this.#settings.segmentPlannerMode === 'legacy_greedy' ? 'legacy_greedy' : 'adaptive_balanced';
    // Tiny synthetic budgets are retained for legacy fixtures and targeted
    // repair workflows. Real historical rebuilds use the adaptive planner.
    return configured === 'adaptive_balanced' && (Number(this.#settings.segmentTarget) || 5_000) >= 256
      ? 'adaptive_balanced'
      : 'legacy_greedy';
  }

  #rebuildConfig() {
    const context = this.#context.context();
    const plannerMode = this.#plannerMode();
    return {
      model: context.chatCompletionSettings?.custom_model ?? context.getChatCompletionModel?.(context.chatCompletionSettings) ?? null,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      segmentSchemaVersion: 1,
      planner: {
        ...this.#segmentBudgets(),
        atomicTurns: true,
        mode: plannerMode,
        maxBundles: Math.max(1, Math.min(5, Math.floor(Number(this.#settings.segmentMaxTurnBundles) || 5))),
        safetyRatio: Math.max(0.1, Math.min(1, Number(this.#settings.segmentInputSafetyRatio) || 0.8)),
        nearOptimalRatio: Math.max(1, Number(this.#settings.segmentNearOptimalRatio) || 1.05),
        safeOverheadRatio: Math.max(1, Number(this.#settings.segmentSafeOverheadRatio) || 1.2),
      },
      extraction: {
        inputBudget: positiveSetting(this.#settings, 'extractionInputBudget', 8_000),
        totalInputBudget: positiveSetting(this.#settings, 'rebuildTotalInputBudget', 110_000),
        maxOutputTokens: plannerMode === 'adaptive_balanced'
          ? Math.min(positiveSetting(this.#settings, 'extractionMaxOutputTokens', 4_000), 4_000)
          : positiveSetting(this.#settings, 'extractionMaxOutputTokens', 4_000),
        stateTokens: nonNegativeSetting(this.#settings, 'extractionStateBudget', 900),
        chronologicalTokens: nonNegativeSetting(this.#settings, 'extractionChronologicalBudget', 1_600),
        historicalTokens: nonNegativeSetting(this.#settings, 'extractionHistoricalBudget', 800),
        rawPreludeTokens: nonNegativeSetting(this.#settings, 'extractionRawPreludeBudget', 600),
        continuityStateTokens: nonNegativeSetting(this.#settings, 'extractionContinuityStateBudget', 600),
        continuityRawPreludeTokens: nonNegativeSetting(this.#settings, 'extractionContinuityRawPreludeBudget', 250),
        repairStateTokens: nonNegativeSetting(this.#settings, 'extractionRepairStateBudget', 256),
        fallbackDigestTokens: nonNegativeSetting(this.#settings, 'extractionFallbackDigestBudget', 192),
      },
      context: {
        commitmentAgeOutSegments: nonNegativeSetting(this.#settings, 'commitmentAgeOutSegments', 8),
      },
    };
  }

  #latestResumableSession() {
    return [...(this.#store?.rebuildSessions() ?? [])].reverse().find(session => session.mode !== 'targeted-regeneration' && ['planned', 'running', 'incomplete'].includes(session.status) && this.#sessionConfigCompatible(session)) ?? null;
  }

  #sessionConfigCompatible(session) {
    const current = this.#rebuildConfig();
    if (session?.configFingerprint === rebuildConfigFingerprint(current)) return true;
    // Sessions created before the adaptive planner existed remain resumable
    // with their frozen greedy plan. Compare only fields from that schema.
    if (session?.config?.planner?.mode) return false;
    const legacy = {
      model: current.model,
      promptVersion: current.promptVersion,
      segmentSchemaVersion: current.segmentSchemaVersion,
      planner: { ...this.#segmentBudgets(), atomicTurns: true },
      extraction: {
        inputBudget: current.extraction.inputBudget,
        totalInputBudget: current.extraction.totalInputBudget,
        maxOutputTokens: current.extraction.maxOutputTokens,
        stateTokens: current.extraction.stateTokens,
        chronologicalTokens: current.extraction.chronologicalTokens,
        historicalTokens: current.extraction.historicalTokens,
        rawPreludeTokens: current.extraction.rawPreludeTokens,
      },
    };
    return session?.configFingerprint === rebuildConfigFingerprint(legacy);
  }

  #sourceRangeAudit(source, messages) {
    const first = source?.first?.messageIndex;
    const last = source?.last?.messageIndex;
    if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) return { matches: false, cosmetic: false, actualRange: null, audit: null };
    if (!Array.isArray(messages) || messages.length !== last - first + 1) return { matches: false, cosmetic: false, actualRange: null, audit: null };
    const actualRange = createSourceRange(messages, first);
    if (Array.isArray(source?.turnBundles) && source.turnBundles.length) {
      const audit = auditTurnBundleIntegrity(source.turnBundles, messages);
      return { matches: audit.narrativeOk, cosmetic: audit.cosmeticOnly, actualRange, audit };
    }
    return { matches: actualRange.rangeFingerprint === source.rangeFingerprint, cosmetic: false, actualRange, audit: null };
  }

  #refreshSessionSourceProvenance(session, messages) {
    let changed = false;
    const refreshed = new Map();
    for (const item of session.plan ?? []) {
      const first = item.source?.first?.messageIndex;
      const last = item.source?.last?.messageIndex;
      const current = messages.filter(message => message.index >= first && message.index <= last);
      const audit = this.#sourceRangeAudit(item.source, current);
      if (!audit.cosmetic || !audit.actualRange || !audit.audit?.actualBundles) continue;
      const nextSource = {
        ...item.source,
        first: audit.actualRange.first,
        last: audit.actualRange.last,
        rangeFingerprint: audit.actualRange.rangeFingerprint,
        turnBundles: audit.audit.actualBundles,
        turnBundleFingerprint: turnBundleFingerprint(audit.audit.actualBundles),
      };
      item.source = nextSource;
      refreshed.set(item.segmentId, nextSource);
      changed = true;
    }
    if (!changed) return false;
    session.sourceFingerprint = fingerprintValue(session.plan.map(item => item.source?.rangeFingerprint), 'rebuild-source');
    for (const segment of session.segments ?? []) {
      const source = refreshed.get(segment.id);
      if (source) segment.source = structuredClone(source);
    }
    session.updatedAt = Date.now();
    return true;
  }

  #sessionSourceMatches(session, messages) {
    return session.plan.every(item => {
      const first = item.source?.first?.messageIndex;
      const last = item.source?.last?.messageIndex;
      const current = messages.filter(message => message.index >= first && message.index <= last);
      return this.#sourceRangeAudit(item.source, current).matches;
    });
  }

  async #archiveRebuildSession(session, messages, reason) {
    const archived = structuredClone(session);
    let dependencyBroken = reason === 'configuration_changed';
    for (const item of archived.plan) {
      const first = item.source?.first?.messageIndex;
      const last = item.source?.last?.messageIndex;
      const current = messages.filter(message => message.index >= first && message.index <= last);
      const sourceMatches = this.#sourceRangeAudit(item.source, current).matches;
      if (!sourceMatches) dependencyBroken = true;
      if (dependencyBroken) item.status = 'stale';
    }
    archived.status = 'incomplete';
    archived.archivedAt = Date.now();
    archived.archiveReason = reason;
    archived.updatedAt = archived.archivedAt;
    await this.#store.upsertRebuildSession(archived);
    return archived;
  }

  async #compileBoundedExtractionRequest({ target, prior, counted, stateAtStart, inputBudget = null, rebuildConfig = null, schemaVariant = 'standard', protocolStage = 'standard' }) {
    const rebuild = rebuildConfig ?? this.#rebuildConfig();
    const config = rebuild.extraction;
    const adaptive = rebuild.planner.mode === 'adaptive_balanced';
    const safetyCeiling = Math.max(1, Math.floor(config.inputBudget * rebuild.planner.safetyRatio));
    const effectiveInputBudget = Math.min(adaptive ? safetyCeiling : config.inputBudget, Number.isFinite(inputBudget) ? Math.max(1, inputBudget) : config.inputBudget);
    const historical = [];
    for (const segment of prior) {
      const rendered = `${segment.summary?.synopsis ?? ''}\n${(segment.summary?.threads ?? []).map(value => `${value.key}:${value.transition}`).join(',')}\n${(segment.summary?.commitments ?? []).map(value => `${value.id ?? value.content}:${value.transition}`).join(',')}`;
      historical.push({ ...segment, tokenCount: await this.#context.countTokens(rendered) });
    }
    const base = adaptive
      ? { stateTokens: isFallbackStage(protocolStage) ? config.fallbackDigestTokens : protocolStage === 'compact' ? config.repairStateTokens : config.continuityStateTokens, chronologicalTokens: 0, historicalTokens: 0, rawPreludeTokens: protocolStage === 'standard' ? config.continuityRawPreludeTokens : 0 }
      : { stateTokens: config.stateTokens, chronologicalTokens: config.chronologicalTokens, historicalTokens: config.historicalTokens, rawPreludeTokens: config.rawPreludeTokens };
    const compile = budgets => compileExtractionRequest({ target, stateAtStart, previousSummaries: historical.slice(-8), olderMemories: historical.slice(0, -8), rawPrelude: counted.filter(message => message.index < target.firstIndex).slice(-8), budgets, schemaVariant });
    let budgets = { ...base };
    let request = compile(budgets);
    const estimate = value => this.#context.countTokens(renderedProviderInput(value));
    let estimatedInputTokens = await estimate(request);
    for (const key of adaptive
      ? (protocolStage === 'standard' ? ['rawPreludeTokens', 'stateTokens'] : ['stateTokens'])
      : ['rawPreludeTokens', 'historicalTokens', 'chronologicalTokens']) {
      if (estimatedInputTokens <= effectiveInputBudget) break;
      budgets = { ...budgets, [key]: 0 };
      request = compile(budgets);
      estimatedInputTokens = await estimate(request);
    }
    return { ...request, estimatedInputTokens, inputBudgetTokens: effectiveInputBudget };
  }

  async #loadReplaySource(session) {
    if (!session || !this.#attemptStore) return null;
    const rawAttempts = await this.#attemptStore.exportRebuildAttempts(this.#chatId, session.id);
    if (!rawAttempts.length) {
      this.#generationState = { ...this.#generationState, replaySessionId: session.id, availableSegmentCount: 0, missingSegmentCount: session.plan.length, availableAttemptCount: 0 };
      return null;
    }
    const source = new ReplayGenerationAdapter({ session, rawAttempts, metrics: this.#metrics });
    const status = source.status();
    this.#generationState = {
      ...this.#generationState,
      replaySessionId: session.id,
      availableSegmentCount: status.availableSegmentIds.length,
      missingSegmentCount: status.missingSegmentIds.length,
      availableAttemptCount: status.availableAttemptCount,
      lastError: null,
    };
    return source;
  }

  #noGenerationProjection(pricing, mode) {
    return {
      inputTokens: { minimum: 0, likely: 0, maximum: 0 },
      outputTokens: { minimum: 0, target: 0, safetyMaximum: 0 },
      credits: { minimum: 0, maximum: 0 },
      pricing: structuredClone(pricing),
      methodology: mode === 'replay' ? 'replay_recorded_outputs_no_provider_requests' : 'offline_no_provider_requests',
    };
  }

  async #stopWithoutGeneration(session, status, mode, report = null) {
    const current = this.#store.getRebuildSession(session.id) ?? session;
    const nextReport = structuredClone(report ?? current.report ?? {
      chatId: this.#chatId,
      sessionId: current.id,
      startedAt: new Date().toISOString(),
      completedAt: null,
      mode: current.mode,
      processed: 0,
      valid: 0,
      failed: 0,
      retries: 0,
      outputs: [],
    });
    nextReport.interruption = { code: status, executionMode: mode };
    nextReport.cost = aggregateAttemptCosts(current.attempts);
    const nextSession = { ...current, status: 'incomplete', updatedAt: Date.now(), report: nextReport };
    await this.#store.upsertRebuildSession(nextSession);
    const analysis = await this.analyzeBackfill({ sessionId: current.id, executionMode: mode });
    this.#generationState = { ...this.#generationState, mode, operation: status === 'offline' ? 'offline' : status, currentSegmentId: null, requestStartedAt: null, lastError: status === 'offline' ? null : status };
    this.#backfillState = { status, analysis, report: structuredClone(nextReport) };
    return { session: this.#store.getRebuildSession(current.id), ...this.#backfillState };
  }

  async #projectRebuildUsage(plan, counted, pricing, totalInputBudget = null) {
    const config = this.#rebuildConfig().extraction;
    let minimumInputTokens = 0;
    let likelyInputTokens = 0;
    let maximumInputTokens = 0;
    const contextCapacity = config.stateTokens + config.chronologicalTokens + config.historicalTokens + config.rawPreludeTokens;
    for (const item of plan) {
      const base = Number.isFinite(item.minimumInputTokens) ? item.minimumInputTokens : await this.#targetOnlyInputTokens(item, counted);
      minimumInputTokens += base;
      likelyInputTokens += Math.min(config.inputBudget, base + contextCapacity);
      maximumInputTokens += Math.min(config.inputBudget, base + contextCapacity);
    }
    const sessionBudget = Number.isFinite(totalInputBudget) ? totalInputBudget : config.totalInputBudget;
    maximumInputTokens = Math.max(minimumInputTokens, Math.min(maximumInputTokens, sessionBudget));
    likelyInputTokens = Math.min(maximumInputTokens, minimumInputTokens + Math.round((maximumInputTokens - minimumInputTokens) * 0.75));
    const minimumOutputTokens = plan.length * 2_500;
    const targetOutputTokens = plan.length * 3_000;
    return {
      inputTokens: { minimum: minimumInputTokens, likely: likelyInputTokens, maximum: maximumInputTokens },
      outputTokens: { minimum: minimumOutputTokens, target: targetOutputTokens, safetyMaximum: plan.length * config.maxOutputTokens },
      credits: {
        minimum: calculateCredits({ nominalInputTokens: likelyInputTokens, uncachedInputTokens: likelyInputTokens, outputTokens: minimumOutputTokens }, pricing),
        maximum: calculateCredits({ nominalInputTokens: maximumInputTokens, uncachedInputTokens: maximumInputTokens, outputTokens: targetOutputTokens }, pricing),
      },
      pricing: structuredClone(pricing),
      methodology: 'local_target_count_plus_bounded_context_estimate',
    };
  }

  async #projectCompactRetry(session, remaining, counted, pricing) {
    if (!session || !Array.isArray(remaining) || !remaining.length) return null;
    const target = remaining.find(item => item.status !== 'valid');
    if (!target) return null;
    const targetAttempts = (session.attempts ?? []).filter(attempt => attempt.segmentId === target.segmentId);
    const retryStage = retryStageForAttempts(targetAttempts);
    if (retryStage === 'standard') return null;
    const latestAttempt = [...targetAttempts].reverse().at(0);
    if (!latestAttempt) return null;
    const inputTokens = Number.isFinite(latestAttempt.usage?.nominalInputTokens)
      ? latestAttempt.usage.nominalInputTokens
      : (target.minimumInputTokens ?? await this.#targetOnlyInputTokens(target, counted));
    const outputTokens = Math.min(
      Number(session.config?.extraction?.maxOutputTokens) || 4_000,
      retryStage === 'tight_fallback' ? TIGHT_FALLBACK_MAX_OUTPUT_TOKENS : retryStage === 'minimal_fallback' ? MINIMAL_FALLBACK_MAX_OUTPUT_TOKENS : COMPACT_RETRY_MAX_OUTPUT_TOKENS,
    );
    const noCache = calculateCredits({ nominalInputTokens: inputTokens, uncachedInputTokens: inputTokens, outputTokens }, pricing);
    const previousCached = Number.isFinite(latestAttempt.usage?.cachedInputTokens)
      ? Math.min(inputTokens, Math.max(0, latestAttempt.usage.cachedInputTokens))
      : 0;
    const prefixCached = calculateCredits({ nominalInputTokens: inputTokens, cachedInputTokens: previousCached, uncachedInputTokens: inputTokens - previousCached, outputTokens }, pricing);
    return {
      segmentId: target.segmentId,
      stage: retryStage,
      protocol: session.config?.planner?.mode === 'adaptive_balanced'
        ? (retryStage === 'tight_fallback' ? ADAPTIVE_TIGHT_FALLBACK_PROTOCOL : retryStage === 'minimal_fallback' ? ADAPTIVE_FALLBACK_PROTOCOL : ADAPTIVE_COMPACT_PROTOCOL)
        : retryProtocolForStage(retryStage),
      mode: isFallbackStage(retryStage) ? 'fallback' : 'structured',
      inputTokens,
      outputTokens,
      maxOutputTokens: outputTokens,
      previousCachedInputTokens: previousCached,
      credits: { noCache, withPreviousCache: prefixCached },
      cacheObserved: previousCached > 0,
      methodology: retryStage === 'tight_fallback'
        ? 'one_explicit_tight_fallback_retry; output_cap_1200; cache_is_not_guaranteed'
        : retryStage === 'minimal_fallback'
          ? 'one_explicit_minimal_fallback_retry; output_cap_3500; cache_is_not_guaranteed'
        : 'one_explicit_compact_retry; output_cap_2500; cache_is_not_guaranteed',
    };
  }

  async #targetOnlyInputTokens(item, counted) {
    const firstIndex = item.source?.first?.messageIndex ?? item.firstIndex;
    const lastIndex = item.source?.last?.messageIndex ?? item.lastIndex;
    const target = { ...item, firstIndex, lastIndex, messages: counted.filter(message => message.index >= firstIndex && message.index <= lastIndex) };
    const request = compileExtractionRequest({ target, stateAtStart: null, previousSummaries: [], olderMemories: [], rawPrelude: [], budgets: { stateTokens: 0, chronologicalTokens: 0, historicalTokens: 0, rawPreludeTokens: 0 } });
    return this.#context.countTokens(renderedProviderInput(request));
  }

  async #extractRebuildTarget(session, targetItem, counted, { executionMode = 'live', replaySource = null } = {}) {
    const firstIndex = targetItem.source.first.messageIndex;
    const lastIndex = targetItem.source.last.messageIndex;
    const target = { id: targetItem.segmentId, firstIndex, lastIndex, source: structuredClone(targetItem.source), sourceTokenCount: targetItem.sourceTokenCount, boundaryReason: targetItem.boundaryReason, oversized: targetItem.oversized };
    const priorSource = session.mode === 'targeted-regeneration' ? this.#store.timeline() : session.segments;
    const prior = priorSource.filter(segment => segment.status === 'valid' && segment.id !== target.id && segment.source.last.messageIndex < firstIndex).sort((a, b) => a.source.first.messageIndex - b.source.first.messageIndex);
    const now = Date.now();
    const pending = { ...target, dependencyIds: prior.map(segment => segment.id), summary: null, status: 'pending', createdAt: now, updatedAt: now, schemaVersion: 1, promptVersion: EXTRACTION_PROMPT_VERSION, manuallyEdited: false, pinned: false };
    const replay = new ReplayEngine({ metrics: this.#metrics }).replay(prior);
    const adaptive = session.config?.planner?.mode === 'adaptive_balanced';
    const retryStage = retryStageForAttempts(session.attempts.filter(attempt => attempt.segmentId === target.id));
    const stateBudget = adaptive
      ? isFallbackStage(retryStage) ? session.config.extraction.fallbackDigestTokens : retryStage === 'compact' ? session.config.extraction.repairStateTokens : session.config.extraction.continuityStateTokens
      : this.#settings.extractionStateBudget;
    const stateAtStart = await this.#packExtractionState(replay.state, Number(stateBudget) || 900, { entityRecords: this.#store.snapshot().entities ?? [], segments: prior });
    const targetMessages = counted.filter(message => message.index >= firstIndex && message.index <= lastIndex);
    const spentInputTokens = session.attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.usage?.nominalInputTokens) ? attempt.usage.nominalInputTokens : 0), 0);
    const remainingInputBudget = Math.max(1, session.config.extraction.totalInputBudget - spentInputTokens);
    const futureEssentialInput = session.plan
      .filter(item => item.segmentId !== target.id && item.status !== 'valid')
      .reduce((sum, item) => sum + (item.essentialInputTokens ?? item.minimumInputTokens ?? 0), 0);
    const requestInputBudget = Math.min(
      session.config.extraction.inputBudget,
      Math.max(targetItem.essentialInputTokens ?? targetItem.minimumInputTokens ?? 1, remainingInputBudget - futureEssentialInput),
    );
    let request = await this.#compileBoundedExtractionRequest({ target: { ...target, messages: targetMessages }, prior, counted, stateAtStart, inputBudget: requestInputBudget, rebuildConfig: session.config, schemaVariant: retryStage === 'compact' ? 'compact' : 'standard', protocolStage: retryStage });
    if (retryStage === 'compact') {
      request = {
        ...request,
        systemPrompt: `${request.systemPrompt}\n\n${COMPACT_RETRY_INSTRUCTION}`,
      };
      request.estimatedInputTokens = await this.#context.countTokens(renderedProviderInput(request));
    }
    const protocol = adaptive
      ? (retryStage === 'compact' ? ADAPTIVE_COMPACT_PROTOCOL : retryStage === 'tight_fallback' ? ADAPTIVE_TIGHT_FALLBACK_PROTOCOL : retryStage === 'minimal_fallback' ? ADAPTIVE_FALLBACK_PROTOCOL : ADAPTIVE_CONTINUITY_PROTOCOL)
      : retryProtocolForStage(retryStage);
    const preferFallback = isFallbackStage(retryStage);
    const fallbackInstruction = retryStage === 'tight_fallback' ? TIGHT_FALLBACK_INSTRUCTION : MINIMAL_FALLBACK_INSTRUCTION;
    if (preferFallback) {
      // The normal contract deliberately insists on JSON.  Leaving that
      // instruction in the fallback prompt would contradict the tagged
      // recovery protocol and makes providers keep emitting JSON (which the
      // fallback parser correctly rejects as missing [SYNOPSIS]).
      request = {
        ...request,
        systemPrompt: String(request.systemPrompt ?? '').replace(EXTRACTION_JSON_MODE_INSTRUCTION, '').trim(),
      };
      // Fallback requests deliberately omit the JSON schema. Keep estimated
      // usage honest when a provider does not return token accounting.
      request.estimatedInputTokens = await this.#context.countTokens(`${request.systemPrompt}\n\n${fallbackInstruction}\n\n${request.prompt}`);
    }
    const generationAdapter = executionMode === 'replay'
      ? replaySource
      : this.#tokenGuard.wrap(new MemoryGenerationAdapter({ getContext: () => this.#context.context(), metrics: this.#metrics, logger: this.#logger, cooldownMs: this.#settings.memoryCooldownMs, temperature: this.#settings.memoryTemperature, topP: this.#settings.memoryTopP }));
    const engine = new ExtractionEngine({ generationAdapter, metrics: this.#metrics, logger: this.#logger, commit: async () => {} });
    const priorAttemptCount = session.attempts.filter(attempt => attempt.segmentId === target.id).length;
    const onAttempt = async payload => {
      const attemptNumber = priorAttemptCount + payload.attempt;
      const providerMeasured = payload.usage && Object.values(payload.usage).some(value => Number.isFinite(value));
      const estimatedOutputTokens = payload.text ? await this.#context.countTokens(payload.text) : null;
      const replayed = payload.executionMode === 'replay';
      const usage = providerMeasured
        ? payload.usage
        : replayed
          ? (payload.usage ?? { nominalInputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null })
          : { nominalInputTokens: request.estimatedInputTokens, cachedInputTokens: null, uncachedInputTokens: request.estimatedInputTokens, outputTokens: estimatedOutputTokens };
      const usageSource = replayed ? 'replay' : (providerMeasured ? 'provider' : 'estimated');
      const durationMs = Number.isFinite(payload.durationMs) ? Math.max(0, payload.durationMs) : null;
      const throughputTokensPerSecond = durationMs > 0 && Number.isFinite(usage?.outputTokens) && usage.outputTokens > 0
        ? usage.outputTokens / (durationMs / 1_000)
        : null;
      const blob = { ...structuredClone(payload), usage, usageSource, estimatedTokenizer: providerMeasured || replayed ? null : 'sillytavern-active', promptVersion: request.promptVersion, schemaVersion: session.config.segmentSchemaVersion, throughputTokensPerSecond };
      const stored = this.#attemptStore ? await this.#attemptStore.putRebuildAttempt(this.#chatId, session.id, target.id, attemptNumber, blob) : null;
      const ref = stored?.ref ?? null;
      const historicalCredits = replayed ? calculateCredits(usage, session.pricing) : null;
      session.attempts.push({ segmentId: target.id, attempt: stored?.attemptNumber ?? attemptNumber, mode: payload.mode, executionMode: payload.executionMode ?? executionMode, replaySourceRef: payload.replayRef ?? null, protocol, promptVersion: request.promptVersion, schemaVersion: session.config.segmentSchemaVersion, rawOutputRef: ref, status: payload.error ? 'failed' : 'received', failure: payload.error?.code ?? null, errorDetail: summarizeProviderError(payload.error), requestId: payload.requestId ?? null, model: payload.model ?? session.config.model, finishReason: payload.finishReason ?? null, outputCharacters: payload.text?.length ?? null, usage, usageSource, replayedCredits: historicalCredits, credits: replayed ? 0 : calculateCredits(usage, session.pricing), requestStartedAt: payload.requestStartedAt ?? null, durationMs, throughputTokensPerSecond, createdAt: payload.receivedAt });
      session.status = 'running'; session.updatedAt = Date.now();
      await this.#store.upsertRebuildSession(session);
      return ref;
    };
    const configuredMaxOutputTokens = adaptive
      ? Math.min(Number(this.#settings.extractionMaxOutputTokens) || 4_000, 4_000)
      : (Number(this.#settings.extractionMaxOutputTokens) || 4_000);
    // The first truncation retry is a compact structured request. If that
    // request is also cut off, the next explicit resume switches to a tagged
    // synopsis-first fallback with a slightly larger ceiling. This avoids
    // paying for the same 2,500-token failure repeatedly while retaining every
    // prior raw attempt for audit/replay.
    const retryMaxOutputTokens = retryStage === 'compact'
      ? Math.min(configuredMaxOutputTokens, COMPACT_RETRY_MAX_OUTPUT_TOKENS)
      : retryStage === 'tight_fallback'
        ? Math.min(configuredMaxOutputTokens, TIGHT_FALLBACK_MAX_OUTPUT_TOKENS)
        : retryStage === 'minimal_fallback'
          ? Math.min(configuredMaxOutputTokens, MINIMAL_FALLBACK_MAX_OUTPUT_TOKENS)
          : configuredMaxOutputTokens;
    const result = await engine.extract({ segment: pending, request, profileId: this.#settings.memoryConnectionProfileId, maxRetries: 0, maxProviderRetries: preferFallback ? MAX_PROVIDER_RETRIES_PER_RESUME : 0, preferFallback, fallbackInstruction: preferFallback ? fallbackInstruction : undefined, entityContextKey: this.#chatId, knownEntities: materializeEntities(prior, { contextKey: this.#chatId }), maxTokens: retryMaxOutputTokens, onAttempt });
    const segment = { ...result.segment, extraction: { ...(result.segment.extraction ?? {}), estimatedInputTokens: request.estimatedInputTokens, inputBudgetTokens: request.inputBudgetTokens, maxOutputTokens: retryMaxOutputTokens } };
    const segmentIndex = session.segments.findIndex(value => value.id === segment.id);
    if (segmentIndex >= 0) session.segments[segmentIndex] = segment;
    else session.segments.push(segment);
    const planItem = session.plan.find(item => item.segmentId === segment.id);
    planItem.status = segment.status;
    const latestAttempt = [...session.attempts].reverse().find(attempt => attempt.segmentId === segment.id);
    if (latestAttempt) {
      latestAttempt.status = segment.status;
      latestAttempt.failure = segment.extraction?.failure ?? null;
      latestAttempt.failureDetails = segment.extraction?.failureDetails ?? null;
      latestAttempt.maxOutputTokens = retryMaxOutputTokens;
    }
    session.updatedAt = Date.now();
    await this.#store.upsertRebuildSession(session);
    return { session: this.#store.getRebuildSession(session.id), result: { ...result, segment } };
  }

  async #recoverRebuildTargetLocally(session, targetItem) {
    if (!this.#attemptStore || !['pending', 'failed'].includes(targetItem.status)) return null;
    let attempt = [...session.attempts].reverse().find(value => value.segmentId === targetItem.segmentId && value.rawOutputRef);
    const attemptMetadataExists = Boolean(attempt);
    let raw = attempt ? await this.#attemptStore.getRebuildAttempt(this.#chatId, attempt.rawOutputRef) : null;
    if (!raw && typeof this.#attemptStore.latestRebuildAttempt === 'function') {
      const latest = await this.#attemptStore.latestRebuildAttempt(this.#chatId, session.id, targetItem.segmentId);
      if (latest) {
        raw = latest.value;
        attempt = { segmentId: targetItem.segmentId, attempt: latest.attempt, rawOutputRef: latest.ref, mode: raw?.mode ?? 'structured', executionMode: raw?.executionMode ?? 'live', replaySourceRef: raw?.replayRef ?? null, status: raw?.error ? 'failed' : 'received', failure: raw?.error?.code ?? null, requestId: raw?.requestId ?? null, model: raw?.model ?? session.config?.model ?? null, finishReason: raw?.finishReason ?? null, outputCharacters: raw?.text?.length ?? null, usage: raw?.usage ?? null, usageSource: raw?.usageSource ?? 'estimated', createdAt: raw?.receivedAt ?? Date.now(), credits: raw?.executionMode === 'replay' ? 0 : calculateCredits(raw?.usage, session.pricing), replayedCredits: raw?.executionMode === 'replay' ? calculateCredits(raw?.usage, session.pricing) : null };
      }
    }
    if (!attempt || !raw || attempt.finishReason === 'length') return null;
    const prior = session.segments.filter(segment => segment.status === 'valid' && segment.source.last.messageIndex < targetItem.source.first.messageIndex);
    const previous = session.segments.find(value => value.id === targetItem.segmentId) ?? {
      id: targetItem.segmentId,
      source: structuredClone(targetItem.source),
      dependencyIds: prior.map(segment => segment.id),
      sourceTokenCount: targetItem.sourceTokenCount,
      summary: null,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schemaVersion: 1,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      manuallyEdited: false,
      pinned: false,
    };
    if (raw.error || !raw.text) {
      if (attemptMetadataExists) return null;
      if (!session.attempts.some(value => value.rawOutputRef === attempt.rawOutputRef)) {
        session.attempts.push(structuredClone(attempt));
      }
      const failureCode = raw.error?.code ? (String(raw.error.code).startsWith('provider_') ? raw.error.code : `provider_${raw.error.code}`) : 'provider_no_content';
      const failed = {
        ...previous,
        summary: null,
        status: 'failed',
        updatedAt: Date.now(),
        extraction: { failure: failureCode, attempts: [], retries: 0, profileId: this.#settings.memoryConnectionProfileId, usage: attempt.usage ?? raw.usage ?? null, outputCharacters: null, executionMode: attempt.executionMode ?? raw.executionMode ?? 'live', quality: 'failed', replacementEligible: false, rawOutputRef: attempt.rawOutputRef },
      };
      const segmentIndex = session.segments.findIndex(value => value.id === failed.id);
      if (segmentIndex >= 0) session.segments[segmentIndex] = failed; else session.segments.push(failed);
      session.plan.find(value => value.segmentId === failed.id).status = 'failed';
      session.updatedAt = Date.now();
      await this.#store.upsertRebuildSession(session);
      return { session: this.#store.getRebuildSession(session.id), result: { committed: false, segment: failed, retries: 0, failure: failureCode, recoveredLocally: true } };
    }
    const options = { contextKey: this.#chatId, knownEntities: materializeEntities(prior, { contextKey: this.#chatId }) };
    // Re-apply the same provider normalization used during live extraction.
    // Persisted attempts can outlive the normalizer version that first saw
    // them (for example GLM's `increase`/`observation` vocabulary), so local
    // recovery must not reject a paid response or issue a duplicate request.
    const recordedResponse = {
      model: attempt.model ?? raw.model ?? raw.rawResponse?.model ?? session.config?.model ?? null,
      route: raw.route ?? raw.rawResponse?.route ?? null,
      normalizationHints: raw.normalizationHints ?? raw.rawResponse?.normalizationHints ?? null,
    };
    const parsed = attempt.mode === 'fallback'
      ? parseFallbackExtraction(raw.text, options)
      : parseStructured(raw.text, { ...options, ...structuredNormalizationOptions(recordedResponse) });
    if (!parsed.ok) return null;
    if (!session.attempts.some(value => value.rawOutputRef === attempt.rawOutputRef)) {
      session.attempts.push(structuredClone(attempt));
      await this.#store.upsertRebuildSession(session);
    }
    const segment = {
      ...previous,
      summary: parsed.summary,
      status: 'valid',
      updatedAt: Date.now(),
      extraction: {
        ...(previous.extraction ?? {}),
        format: attempt.mode,
        quality: attempt.mode === 'structured' ? 'full' : (parsed.degraded ? 'prose' : 'partial'),
        replacementEligible: !parsed.degraded,
        executionMode: attempt.executionMode ?? raw.executionMode ?? 'live',
        usage: attempt.usage ?? raw.usage ?? null,
        outputCharacters: attempt.outputCharacters ?? raw.text.length,
        finishReason: attempt.finishReason ?? raw.finishReason ?? null,
        recoveredLocallyAt: Date.now(),
        rawOutputRef: attempt.rawOutputRef,
      },
    };
    const segmentIndex = session.segments.findIndex(value => value.id === segment.id);
    if (segmentIndex >= 0) session.segments[segmentIndex] = segment;
    else session.segments.push(segment);
    session.plan.find(value => value.segmentId === segment.id).status = 'valid';
    session.localRecoveries ??= [];
    session.localRecoveries.push({ segmentId: segment.id, rawOutputRef: attempt.rawOutputRef, recoveredAt: Date.now() });
    session.updatedAt = Date.now();
    await this.#store.upsertRebuildSession(session);
    return { session: this.#store.getRebuildSession(session.id), result: { committed: false, segment, retries: 0, failure: null, recoveredLocally: true } };
  }

  #canCommitJob(token, target) {
    if (this.#chatId !== token.chatId) return false;
    const current = this.#context.sourceMessages().filter(message => message.index >= target.firstIndex && message.index <= target.lastIndex);
    if (!current.length) return false;
    const fingerprint = createSourceRange(current, target.firstIndex).rangeFingerprint;
    return this.#jobs.canCommit(token, { chatId: this.#chatId, sourceFingerprint: fingerprint });
  }

  #rememberActiveBranches(messages, segments) {
    for (const message of messages) {
      if (!Array.isArray(message.original?.swipes) || message.original.swipes.length < 2) continue;
      const fingerprint = createMessageSourceRef(message, message.index).messageFingerprint;
      this.#mutations.storeBranch(message.index, fingerprint, segments);
    }
  }

  #ageOutCommitments(state, segments = [], operation = 'projection') {
    const result = applyCommitmentAgeOut(state, segments, { maxSegments: this.#settings.commitmentAgeOutSegments });
    if (result.agedOut.length) {
      this.#metrics.record({
        operation: 'commitment_age_out',
        status: 'projected',
        stage: operation,
        thresholdSegments: Math.max(0, Math.floor(Number(this.#settings.commitmentAgeOutSegments) || 0)),
        agedOutCount: result.agedOut.length,
        agedOutIds: result.agedOut.map(item => item.id).slice(0, 16),
      });
    }
    return result;
  }

  async #packExtractionState(state, budgetTokens = 1_200, projectionOptions = {}) {
    const projected = this.#ageOutCommitments(state, projectionOptions.segments ?? [], 'extraction');
    const selected = [];
    let tokenCount = 0;
    for (const item of projectNarrativeState(projected.state, { ...projectionOptions, commitmentAgeOutSegments: 0 })) {
      const candidate = [...selected, item.text].join('\n');
      const count = await this.#context.countTokens(candidate);
      if (count > budgetTokens) continue;
      selected.push(item.text);
      tokenCount = count;
    }
    return selected.length ? { text: selected.join('\n'), tokenCount } : null;
  }

  async #refreshMaterialized() {
    const segments = this.#activeSegments(this.#context.sourceMessages(), this.#store.timeline({ includeExcluded: false }));
    await this.#store.replaceMaterialized({
      entities: materializeEntities(segments, { contextKey: this.#chatId, existing: this.#store.snapshot().entities ?? [] }),
      registers: materializeRegisters(segments),
    });
  }

  #activeSegments(messages, segments) {
    return activeInjectableSegments(segments).filter(segment => this.#sourceMatches(messages, segment));
  }

  #getMessageHealthIndex() {
    if (!this.#store) return new Map();
    const revision = this.#store.revision?.() ?? null;
    if (this.#messageHealthIndexCache.store === this.#store && (revision === null || this.#messageHealthIndexCache.revision === revision)) return this.#messageHealthIndexCache.byIndex;
    const byIndex = new Map();
    for (const segment of this.#store.timeline()) {
      const first = segment.source?.first?.messageIndex;
      const last = segment.source?.last?.messageIndex;
      if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) continue;
      for (let index = first; index <= last; index += 1) if (!byIndex.has(index)) byIndex.set(index, segment);
    }
    this.#messageHealthIndexCache = { store: this.#store, revision, byIndex };
    return byIndex;
  }

  #sourceMatches(messages, segment) {
    const first = segment.source?.first?.messageIndex;
    const last = segment.source?.last?.messageIndex;
    if (!Number.isInteger(first) || !Number.isInteger(last)) return false;
    const current = messages.filter(message => message.index >= first && message.index <= last);
    return this.#sourceRangeAudit(segment.source, current).matches;
  }

  async #auditStoredIntegrity(messages) {
    const segments = this.#store.timeline();
    let migratedLegacyCount = 0;
    let cosmeticRefreshCount = 0;
    for (const segment of segments) {
      const first = segment.source?.first?.messageIndex;
      const last = segment.source?.last?.messageIndex;
      if (!Number.isInteger(first) || !Number.isInteger(last)) continue;
      const current = messages.filter(message => message.index >= first && message.index <= last);
      if (current.length !== last - first + 1) continue;
      if (Array.isArray(segment.source?.turnBundles) && segment.source.turnBundles.length) {
        const audit = auditTurnBundleIntegrity(segment.source.turnBundles, current);
        if (audit.cosmeticOnly) {
          segment.source = { ...segment.source, turnBundles: audit.actualBundles, turnBundleFingerprint: turnBundleFingerprint(audit.actualBundles) };
          cosmeticRefreshCount += 1;
        }
        continue;
      }
      if (createSourceRange(current, first).rangeFingerprint === segment.source.rangeFingerprint) {
        const turnBundles = createTurnBundles(current);
        segment.source = { ...segment.source, turnBundles, turnBundleFingerprint: turnBundleFingerprint(turnBundles) };
        migratedLegacyCount += 1;
      }
    }
    const mismatched = segments.filter(segment => segment.status === 'valid' && !this.#sourceMatches(messages, segment));
    if (!mismatched.length) {
      if (migratedLegacyCount || cosmeticRefreshCount) await this.#store.replaceSegments(segments);
      this.#lastIntegrity = { status: 'valid', checkedSegments: segments.length, staleSegments: 0, firstChangedIndex: null };
      if (migratedLegacyCount) this.#metrics.record({ operation: 'integrity_migration', status: 'success', migratedSegmentCount: migratedLegacyCount, extractionCalls: 0 });
      if (cosmeticRefreshCount) this.#metrics.record({ operation: 'integrity_cosmetic_refresh', status: 'success', refreshedSegmentCount: cosmeticRefreshCount, extractionCalls: 0 });
      return this.#lastIntegrity;
    }
    const firstChangedIndex = Math.min(...mismatched.map(segment => segment.source?.first?.messageIndex ?? Infinity));
    const result = this.#mutations.handleEdit(segments, firstChangedIndex);
    await this.#store.replaceSegments(result.segments);
    await this.#rebuildLexical(activeInjectableSegments(result.segments));
    this.#lastIntegrity = { status: 'stale', checkedSegments: segments.length, staleSegments: result.staleCount, firstChangedIndex };
    this.#metrics.record({ operation: 'integrity_audit', status: 'stale', checkedSegmentCount: segments.length, staleSegmentCount: result.staleCount, firstChangedIndex, extractionCalls: 0 });
    return this.#lastIntegrity;
  }

  async #countMessages(messages) {
    const counted = [];
    const tokenizerKey = this.#context.tokenizerKey?.() ?? 'unknown:unknown';
    this.#tokenizerKeys.add(tokenizerKey);
    let dirty = false;
    for (const message of messages) {
      const result = await this.#tokens.count(message, message.index, { tokenizerKey, countTokens: text => this.#context.countTokens(text) });
      if (result.cacheStatus === 'miss') dirty = true;
      counted.push({ ...message, tokenCount: result.tokenCount });
    }
    if (dirty && this.#attemptStore?.putTokenCache) {
      try {
        await this.#attemptStore.putTokenCache(this.#chatId, { tokenizerKeys: [...this.#tokenizerKeys], entries: this.#tokens.serialize() });
        this.#metrics.record({ operation: 'acceleration_token_cache', status: 'persisted', entryCount: this.#tokens.size, tokenizerKey });
      } catch (error) {
        this.#metrics.record({ operation: 'acceleration_token_cache', status: 'write_failed', errorName: error?.name ?? 'Error' });
      }
    }
    return counted;
  }

  #lexicalFingerprint(segments) {
    return fingerprintValue(segments.map(segment => ({
      id: segment.id,
      status: segment.status,
      sourceFingerprint: segment.source?.turnBundleFingerprint ?? segment.source?.rangeFingerprint ?? null,
      updatedAt: segment.updatedAt ?? null,
      summary: segment.summary ?? null,
    })), 'lexical-index-v1');
  }

  async #rebuildLexical(segments) {
    const result = this.#lexical.rebuild(segments);
    // An empty index is free to reconstruct and writing it would create
    // external state on otherwise read-only validation paths.
    if (segments.length && this.#attemptStore?.putLexicalIndex && this.#chatId) {
      try {
        await this.#attemptStore.putLexicalIndex(this.#chatId, { fingerprint: this.#lexicalFingerprint(segments), documents: this.#lexical.serialize() });
        this.#metrics.record({ operation: 'acceleration_lexical_index', status: 'persisted', documentCount: this.#lexical.size });
      } catch (error) {
        this.#metrics.record({ operation: 'acceleration_lexical_index', status: 'write_failed', errorName: error?.name ?? 'Error' });
      }
    }
    return result;
  }

  async #restoreLexical(segments) {
    const fingerprint = this.#lexicalFingerprint(segments);
    try {
      const cached = await this.#attemptStore?.getLexicalIndex?.(this.#chatId);
      if (cached?.fingerprint === fingerprint) {
        this.#lexical.hydrate(cached.documents);
        this.#metrics.record({ operation: 'acceleration_lexical_index', status: 'hit', documentCount: this.#lexical.size });
        return { documentCount: this.#lexical.size, cacheStatus: 'hit' };
      }
      this.#metrics.record({ operation: 'acceleration_lexical_index', status: cached ? 'stale' : 'miss', documentCount: segments.length });
    } catch (error) {
      this.#metrics.record({ operation: 'acceleration_lexical_index', status: 'read_failed', errorName: error?.name ?? 'Error' });
    }
    return { ...(await this.#rebuildLexical(segments)), cacheStatus: 'miss' };
  }

  async #replayWithCheckpoint(segments) {
    const engine = new ReplayEngine({ metrics: this.#metrics });
    let stored = null;
    try { stored = await this.#attemptStore?.getReplayCheckpoint?.(this.#chatId); } catch (error) {
      this.#metrics.record({ operation: 'acceleration_replay_checkpoint', status: 'read_failed', errorName: error?.name ?? 'Error' });
    }
    const replay = engine.replay(segments, { checkpoint: stored?.checkpoint ?? null });
    this.#metrics.record({ operation: 'acceleration_replay_checkpoint', status: replay.checkpointLoaded ? 'hit' : (stored ? 'stale' : 'miss'), segmentsReplayed: replay.segmentsReplayed });
    const latest = replay.checkpoints.at(-1);
    if (latest && this.#attemptStore?.putReplayCheckpoint) {
      try { await this.#attemptStore.putReplayCheckpoint(this.#chatId, latest); } catch (error) {
        this.#metrics.record({ operation: 'acceleration_replay_checkpoint', status: 'write_failed', errorName: error?.name ?? 'Error' });
      }
    }
    return replay;
  }

  async #ensureChat() {
    const chatId = this.#context.chatId();
    if (this.#store && this.#chatId === chatId) return this.#store;
    const changed = this.#chatId !== null && this.#chatId !== chatId;
    this.#chatId = chatId;
    if (changed) this.#generationState = { ...this.#generationState, operation: 'idle', replaySessionId: null, availableSegmentCount: 0, missingSegmentCount: 0, availableAttemptCount: 0, currentSegmentId: null, currentSegmentOrdinal: null, totalSegments: null, requestStartedAt: null, lastError: null };
    this.#store = new SemanticStore({ adapter: this.#context, chatId });
    this.#messageHealthIndexCache = { store: null, revision: -1, byIndex: new Map() };
    await this.#store.load();
    await this.refreshProfile();
    let tokenCache = null;
    try { tokenCache = await this.#attemptStore?.getTokenCache?.(chatId); } catch (error) {
      this.#metrics.record({ operation: 'acceleration_token_cache', status: 'read_failed', errorName: error?.name ?? 'Error' });
    }
    this.#tokens = new TokenCountCache({ metrics: this.#metrics, initialEntries: tokenCache?.entries ?? [] });
    this.#tokenizerKeys = new Set(tokenCache?.tokenizerKeys ?? []);
    this.#metrics.record({ operation: 'acceleration_token_cache', status: tokenCache ? 'restored' : 'empty', entryCount: this.#tokens.size });
    const chatPreference = this.#store.preferences().enabled;
    this.#enabled = typeof chatPreference === 'boolean' ? chatPreference : this.#defaultEnabled;
    await this.#restoreLexical(this.#activeSegments(this.#context.sourceMessages(), this.#store.timeline({ includeExcluded: false })));
    return this.#store;
  }
}

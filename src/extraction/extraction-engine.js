import { SCHEMA_VERSION, validateEpisodeSummary } from '../domain/schema.js';
import { parseFallbackExtraction } from './fallback-parser.js';
import { normalizeExtractedSummary } from './semantic-normalizer.js';

export const FALLBACK_INSTRUCTION = `Return the complete tagged fallback protocol below. Finish the synopsis with complete sentences and continue through every section; do not stop after the synopsis. Use exact character names, never invented ids. Untagged prose is ignored.

[SYNOPSIS]
Two to five concise, complete sentences.
[ENTITIES]
- mention=exact name | aliases=alias one,alias two
[EVENTS]
- description=what happened | participants=exact name,exact name | evidence=explicit | salience=important | domains=family,relationship
[OBSERVATIONS]
- fact=continuity-relevant fact | subject=exact name | predicate=stable_key | value=literal value | scope=world | evidence=explicit | persistence=historical | salience=normal | domains=general | continuity=true
[STATE_CHANGES]
- subject=exact name | path=goals.bruges | operation=set | value=reach Bruges in twelve days | evidence=explicit | persistence=active
[KNOWLEDGE]
- holder=exact name | kind=knows | operation=add | proposition=established proposition | evidence=explicit
[RELATIONSHIPS]
- participants=exact name,exact name | dimension=trust | operation=set | value=repairing | evidence=explicit
[COMMITMENTS]
- id=stable_key | actor=exact name | toward=exact name | transition=made | content=promise or obligation | evidence=explicit
[THREADS]
- key=stable_key | transition=open | description=ongoing concrete thread | evidence=explicit
[SALIENT_NEGATIVES]
- proposition=important non-event | reason=explicit refusal, prevention, correction, absence, or boundary | continuity=true
[REGISTERS]
- kind=generic | registerKey=stable_key | observationKey=stable_key | value=continuity-relevant value | evidence=explicit
[INTERPRETATIONS]
- description=careful inference | evidence=weak_inference
[TEMPORAL]
- description=exact or relative time | kind=exact | evidence=explicit
[LOCATIONS]
- subject=exact name | location=place | kind=scene | evidence=explicit

Use empty sections when nothing qualifies. Emit only continuity-relevant items. Reuse existing commitment and thread keys from historical context.`;

/**
 * Return the local normalization switches that were used for a provider
 * response.  Keeping this in one place is important for rebuild recovery:
 * a response may have been persisted before the provider vocabulary aliases
 * were added, and must be parsed with the same rules when it is recovered
 * without another provider request.
 */
function structuredNormalizationOptions(response = {}) {
  const model = String(response?.model ?? '');
  const isGlm5 = /^glm-5(?:\.\d+)?$/i.test(model);
  const route = response?.route;
  return {
    allowOmittedEmptyFamilies: response?.normalizationHints?.allowOmittedEmptyFamilies === true
      || route === 'voidai_json_object'
      || isGlm5,
    allowProviderVocabularyVariants: response?.normalizationHints?.allowProviderVocabularyVariants === true
      || route === 'voidai_json_object'
      || isGlm5,
  };
}

function jsonShape(text) {
  const source = String(text ?? '').trim();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
  }
  return { depth, inString, lastCharacter: source.at(-1) ?? '' };
}

function parsePosition(error) {
  const match = /(?:position|at)\s+(\d+)/i.exec(String(error?.message ?? ''));
  return match ? Number(match[1]) : null;
}

function parseDiagnostics(text, error, kind = 'json_parse') {
  const source = String(text ?? '').trim();
  const shape = jsonShape(source);
  const message = String(error?.message ?? 'JSON parsing failed');
  return {
    kind,
    source: 'local_parser',
    errors: [message],
    parsePosition: parsePosition(error),
    unclosedDepth: shape.depth,
    unterminatedString: shape.inString,
    lastCharacter: shape.lastCharacter,
  };
}

function looksLikeTruncatedJson(text, error) {
  const source = String(text ?? '').trim();
  if (!source || !['{', '['].includes(source[0])) return false;
  const message = String(error?.message ?? '');
  const shape = jsonShape(source);
  // A provider can stop with an unknown/null finish_reason.  Unclosed JSON or
  // a non-container final character is therefore stronger evidence than the
  // provider's finish metadata.  Parser EOF messages remain a fallback hint.
  return shape.depth > 0
    || shape.inString
    || !/[}\]]$/.test(source)
    || /unexpected end of json input|unterminated string|end of json/i.test(message);
}

function parseStructured(text, { contextKey = '', knownEntities = [], allowOmittedEmptyFamilies = false, allowProviderVocabularyVariants = false } = {}) {
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch (error) {
    if (looksLikeTruncatedJson(text, error)) {
      return {
        ok: false,
        reason: 'truncated',
        errors: [error.message],
        diagnostics: parseDiagnostics(text, error, 'json_parse_truncated'),
      };
    }
    return {
      ok: false,
      reason: 'invalid_json',
      errors: [error.message],
      diagnostics: parseDiagnostics(text, error),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    const errors = ['Structured output was empty'];
    return { ok: false, reason: 'empty_object', errors, diagnostics: { kind: 'empty_object', source: 'local_validator', errors } };
  }
  const normalized = normalizeExtractedSummary(parsed, { contextKey, knownEntities, allowOmittedEmptyFamilies, allowProviderVocabularyVariants });
  const validated = validateEpisodeSummary(normalized);
  return validated.ok
    ? { ok: true, summary: validated.value, degraded: false, warnings: [] }
    : {
      ok: false,
      reason: 'schema_invalid',
      errors: validated.errors,
      diagnostics: { kind: 'schema_validation', source: 'local_validator', errors: validated.errors },
    };
}

function providerFailureReason(error) {
  const safeCode = String(error?.code ?? '').toLowerCase();
  if (safeCode === 'token_limit') return 'token_limit';
  if (['quota', 'rate_limit', 'authentication', 'access_denied', 'unavailable', 'moderation', 'no_content'].includes(safeCode)) return `provider_${safeCode}`;
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `provider_http_${status}`;
  const match = /\bHTTP\s+(\d{3})\b/i.exec(String(error?.message ?? ''));
  if (match) return `provider_http_${match[1]}`;
  const name = String(error?.name ?? 'error').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'error';
  return `provider_${name}`;
}

function isRetryableProviderFailure(failure) {
  const normalized = String(failure ?? '').toLowerCase();
  if (!normalized.startsWith('provider_')) return false;
  return ![
    'provider_quota',
    'provider_rate_limit',
    'provider_authentication',
    'provider_access_denied',
    'provider_unavailable',
    'provider_moderation',
    'provider_token_limit',
  ].includes(normalized);
}

function serializeProviderError(error) {
  const serialized = {
    name: error?.name ?? 'Error',
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    status: error?.status ?? error?.statusCode ?? null,
    stack: error?.stack ?? null,
  };
  for (const key of Object.keys(error ?? {})) {
    const value = error[key];
    try { serialized[key] = structuredClone(value); } catch { serialized[key] = String(value); }
  }
  return serialized;
}

export class ExtractionEngine {
  #generation;
  #metrics;
  #logger;
  #commit;
  #committed = new Set();

  constructor({ generationAdapter, metrics = null, logger = null, commit = async () => {} }) {
    if (!generationAdapter?.generate) throw new TypeError('generationAdapter.generate is required');
    this.#generation = generationAdapter;
    this.#metrics = metrics;
    this.#logger = logger;
    this.#commit = commit;
  }

  async extract({ segment, request, profileId = null, maxRetries = 1, maxProviderRetries = 0, preferFallback = false, fallbackInstruction = FALLBACK_INSTRUCTION, entityContextKey = '', knownEntities = [], maxTokens = 4_000, onAttempt = null, signal } = {}) {
    if (!segment?.id || !request?.prompt) throw new TypeError('segment and compiled request are required');
    const finish = this.#metrics?.measure('segment_extraction', {
      segmentId: segment.id,
      sourceFingerprint: segment.source?.rangeFingerprint ?? null,
      promptVersion: request.promptVersion,
      schemaVersion: SCHEMA_VERSION,
      blockingClass: 'background',
    });
    let retries = 0;
    let lastFailure = 'unknown';
    let parsedResult = null;
    let rawUsage = null;
    let lastOutputCharacters = null;
    let lastAttemptMetadata = null;
    let lastExecutionMode = 'live';
    const attempts = [];
    let successfulMode = null;
    const providerRetryBudget = Math.max(0, Math.floor(Number(maxProviderRetries) || 0));
    const allowedRetries = preferFallback ? providerRetryBudget : maxRetries;

    for (let attempt = 0; attempt <= allowedRetries; attempt += 1) {
      const fallbackMode = preferFallback || attempt > 0;
      const requestStartedAt = Date.now();
      this.#logger?.debug?.('memory_attempt_started', {
        segmentId: segment.id,
        attempt: attempt + 1,
        mode: fallbackMode ? 'fallback' : 'structured',
        maxRetries: allowedRetries,
        maxOutputTokens: maxTokens,
        profileId: profileId ?? null,
      });
      try {
        const response = await this.#generation.generate({
            systemPrompt: fallbackMode ? `${request.systemPrompt}\n\n${fallbackInstruction}` : request.systemPrompt,
          prompt: request.prompt,
          jsonSchema: fallbackMode ? null : request.jsonSchema,
          profileId,
          maxTokens,
          segmentId: segment.id,
          sourceFingerprint: segment.source?.rangeFingerprint ?? null,
          estimatedInputTokens: fallbackMode ? null : request.estimatedInputTokens,
          signal,
        });
        lastExecutionMode = response.executionMode ?? 'live';
        rawUsage = response.usage;
        lastOutputCharacters = response.text.length;
        let rawOutputRef = null;
        try {
          rawOutputRef = await onAttempt?.({ attempt: attempt + 1, mode: fallbackMode ? 'fallback' : 'structured', executionMode: response.executionMode ?? 'live', replayRef: response.replayRef ?? null, text: response.text, rawResponse: response.raw ?? null, usage: response.usage, requestId: response.requestId, model: response.model, finishReason: response.finishReason, requestStartedAt, durationMs: Math.max(0, Date.now() - requestStartedAt), receivedAt: Date.now() });
        } catch (persistenceError) {
          this.#logger?.warn?.('memory_attempt_persistence_failed', {
            segmentId: segment.id,
            attempt: attempt + 1,
            mode: fallbackMode ? 'fallback' : 'structured',
            errorName: persistenceError?.name ?? 'Error',
            errorCode: persistenceError?.code ?? 'attempt_persistence',
          });
          persistenceError.code = 'attempt_persistence';
          throw persistenceError;
        }
        this.#logger?.info?.('memory_attempt_persisted', {
          segmentId: segment.id,
          attempt: attempt + 1,
          mode: fallbackMode ? 'fallback' : 'structured',
          executionMode: response.executionMode ?? 'live',
          requestId: response.requestId ?? null,
          model: response.model ?? null,
          finishReason: response.finishReason ?? null,
          outputCharacters: response.text.length,
          ...(response.usage ?? {}),
        });
        lastAttemptMetadata = { rawOutputRef: rawOutputRef ?? null, finishReason: response.finishReason ?? null, requestId: response.requestId ?? null, model: response.model ?? null, executionMode: response.executionMode ?? 'live' };
        const providerLength = response.finishReason === 'length';
        // A provider can report `finish_reason: length` after emitting a complete
        // tagged fallback.  Fallback parsing is deliberately line-oriented and
        // has its own completeness check, so let it validate the payload before
        // treating the provider's length signal as a failure.  Structured JSON
        // remains strict: without a complete JSON document it must be retried.
        parsedResult = fallbackMode
          ? parseFallbackExtraction(response.text, {
            contextKey: entityContextKey,
            knownEntities,
            // The hardened tagged protocol explicitly promises at least one
            // semantic record.  Enforce that promise locally so a provider
            // cannot turn a failed extraction into an accepted synopsis-only
            // candidate.  Legacy callers retain the old permissive behavior.
            requireSemantic: /at least one continuity-critical semantic line/i.test(fallbackInstruction),
          })
          : providerLength
            ? { ok: false, reason: 'truncated', errors: ['Provider stopped at the completion length limit'], diagnostics: { kind: 'provider_finish_reason', source: 'provider' } }
            : parseStructured(response.text, {
              contextKey: entityContextKey,
              knownEntities,
              ...structuredNormalizationOptions(response),
            });
        if (parsedResult.ok && providerLength && fallbackMode) {
          parsedResult = {
            ...parsedResult,
            warnings: [
              ...(parsedResult.warnings ?? []),
              'Provider reported finish_reason:length; accepted complete tagged fallback.',
            ],
          };
        }
        if (parsedResult.ok) {
          successfulMode = fallbackMode ? 'fallback' : 'structured';
          break;
        }
        lastFailure = parsedResult.reason ?? 'fallback_invalid';
        const validationErrors = parsedResult.errors ?? (parsedResult.diagnostics?.errors ?? []);
        const diagnostics = parsedResult.diagnostics ?? (validationErrors.length
          ? { kind: fallbackMode ? 'fallback_validation' : 'validation', source: 'local_validator', errors: validationErrors }
          : null);
        const errorCount = validationErrors.length || parsedResult.warnings?.length || 0;
        attempts.push({ attempt: attempt + 1, mode: fallbackMode ? 'fallback' : 'structured', reason: lastFailure, errorCount, diagnostics, outputCharacters: response.text.length, ...lastAttemptMetadata });
        this.#logger?.warn?.('memory_attempt_validation_failed', {
          segmentId: segment.id,
          attempt: attempt + 1,
          mode: fallbackMode ? 'fallback' : 'structured',
          executionMode: response.executionMode ?? 'live',
          failure: lastFailure,
          requestId: response.requestId ?? null,
          model: response.model ?? null,
          finishReason: response.finishReason ?? null,
          rawOutputRef: rawOutputRef ?? null,
          errorCount,
          diagnosticKind: diagnostics?.kind ?? null,
          validationErrors,
        });
      } catch (error) {
        if (error?.code === 'attempt_persistence') throw error;
        lastExecutionMode = error?.executionMode ?? lastExecutionMode;
        lastFailure = signal?.aborted ? 'cancelled' : providerFailureReason(error);
        let rawOutputRef = null;
        try {
          rawOutputRef = await onAttempt?.({
            attempt: attempt + 1,
            mode: fallbackMode ? 'fallback' : 'structured',
            executionMode: error?.executionMode ?? 'live',
            error: serializeProviderError(error),
            usage: error?.usage ?? null,
            requestId: error?.requestId ?? null,
            model: error?.model ?? null,
            finishReason: error?.finishReason ?? null,
            rawResponse: error?.rawResponse ?? null,
            replayRef: error?.replayRef ?? null,
            requestStartedAt,
            durationMs: Math.max(0, Date.now() - requestStartedAt),
            receivedAt: Date.now(),
          });
        } catch (persistenceError) {
          this.#logger?.warn?.('memory_attempt_persistence_failed', {
            segmentId: segment.id,
            attempt: attempt + 1,
            mode: fallbackMode ? 'fallback' : 'structured',
            errorName: persistenceError?.name ?? 'Error',
            errorCode: persistenceError?.code ?? 'attempt_persistence',
          });
          persistenceError.code = 'attempt_persistence';
          throw persistenceError;
        }
        this.#logger?.warn?.('memory_attempt_recorded_error', {
          segmentId: segment.id,
          attempt: attempt + 1,
          mode: fallbackMode ? 'fallback' : 'structured',
          executionMode: error?.executionMode ?? 'live',
          requestId: error?.requestId ?? null,
          model: error?.model ?? null,
          finishReason: error?.finishReason ?? null,
          errorName: error?.name ?? 'Error',
          errorCode: error?.code ?? null,
        });
        attempts.push({ attempt: attempt + 1, mode: fallbackMode ? 'fallback' : 'structured', reason: lastFailure, errorCount: 1, outputCharacters: null, rawOutputRef: rawOutputRef ?? null });
        if (signal?.aborted || !isRetryableProviderFailure(lastFailure) || attempt >= allowedRetries) break;
      }
      if (attempt < allowedRetries) retries += 1;
    }

    if (!parsedResult?.ok) {
      const failed = Object.freeze({
        ...segment,
        summary: null,
        status: 'failed',
        updatedAt: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        promptVersion: request.promptVersion,
        extraction: { failure: lastFailure, failureDetails: attempts.at(-1)?.diagnostics ?? null, attempts, retries, profileId, usage: rawUsage, outputCharacters: lastOutputCharacters, executionMode: lastExecutionMode, quality: 'failed', replacementEligible: false },
      });
      finish?.({ status: 'failed', retryCount: retries, failureClass: lastFailure, ...(rawUsage ?? {}) });
      return { committed: false, segment: failed, retries, failure: lastFailure };
    }

    const format = successfulMode ?? (preferFallback ? 'fallback' : 'structured');
    const quality = format === 'structured' ? 'full' : (parsedResult.degraded ? 'prose' : 'partial');
    const valid = Object.freeze({
      ...segment,
      summary: parsedResult.summary,
      status: 'valid',
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      promptVersion: request.promptVersion,
      extraction: {
        format,
        quality,
        replacementEligible: quality !== 'prose',
        degraded: Boolean(parsedResult.degraded),
        warnings: parsedResult.warnings ?? [],
        attempts,
        initialFailure: attempts[0] ?? null,
        retries,
        profileId,
        usage: rawUsage,
        outputCharacters: lastOutputCharacters,
        executionMode: lastExecutionMode,
        ...lastAttemptMetadata,
      },
    });
    const commitKey = `${segment.id}:${segment.source?.rangeFingerprint ?? ''}`;
    let committed = false;
    if (!this.#committed.has(commitKey)) {
      await this.#commit(valid);
      this.#committed.add(commitKey);
      committed = true;
    }
    finish?.({ status: 'success', retryCount: retries, outputFormat: valid.extraction.format, outputQuality: quality, replacementEligible: valid.extraction.replacementEligible, ...(rawUsage ?? {}) });
    return { committed, segment: valid, retries, failure: null };
  }
}

export class CompactionCoordinator {
  #engine;
  #metrics;

  constructor({ engine, metrics = null }) {
    this.#engine = engine;
    this.#metrics = metrics;
  }

  async observeStoryTurn({ extractionJob = null } = {}) {
    this.#metrics?.record({ operation: 'story_generation_observed', extractionScheduled: Boolean(extractionJob) });
    if (!extractionJob) return { extractionCalls: 0, result: null };
    const result = await this.#engine.extract(extractionJob);
    return { extractionCalls: 1 + result.retries, result };
  }
}

export { parseStructured, structuredNormalizationOptions };

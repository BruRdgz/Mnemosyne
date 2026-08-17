import { normalizeProviderUsage } from '../observability/metrics-recorder.js';
import { validateRebuildSession } from './rebuild-session.js';

export const GENERATION_MODES = Object.freeze(['live', 'replay', 'offline']);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function parseInput(value) {
  if (typeof value !== 'string') return clone(value);
  try { return JSON.parse(value); } catch { throw new ReplayArtifactError('Replay artifact is not valid JSON', 'replay_invalid_json'); }
}

function keyPattern(sessionId) {
  return new RegExp(`^rebuild:${String(sessionId).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:([^:]+):(\\d+)$`);
}

function parseAttemptRef(ref, sessionId) {
  if (typeof ref !== 'string') return null;
  const match = keyPattern(sessionId).exec(ref);
  if (!match) return null;
  return { segmentId: match[1], attempt: Number(match[2]) };
}

export class ReplayArtifactError extends TypeError {
  constructor(message, code = 'replay_invalid') {
    super(message);
    this.name = 'ReplayArtifactError';
    this.code = code;
  }
}

export class ReplayUnavailableError extends Error {
  constructor(message, { segmentId = null, sourceFingerprint = null } = {}) {
    super(message);
    this.name = 'ReplayUnavailableError';
    this.code = 'replay_missing';
    this.segmentId = segmentId;
    this.sourceFingerprint = sourceFingerprint;
    this.executionMode = 'replay';
  }
}

export function normalizeReplayArtifact(input, { expectedChatId, expectedSessionId = null } = {}) {
  const value = parseInput(input);
  const session = value?.session
    ?? (Array.isArray(value?.envelope?.rebuildSessions)
      ? (expectedSessionId
        ? value.envelope.rebuildSessions.find(item => item.id === expectedSessionId)
        : [...value.envelope.rebuildSessions].reverse().find(item => ['promoted', 'complete', 'incomplete', 'planned'].includes(item.status)))
      : null);
  const rawAttempts = value?.rawAttempts ?? [];
  if (!session) throw new ReplayArtifactError('Replay artifact does not contain a rebuild session', 'replay_session_missing');
  validateRebuildSession(session, { expectedChatId });
  if (expectedSessionId && session.id !== expectedSessionId) throw new ReplayArtifactError('Replay artifact session does not match the requested session', 'replay_session_mismatch');
  if (!Array.isArray(rawAttempts)) throw new ReplayArtifactError('Replay artifact rawAttempts must be an array', 'replay_attempts_invalid');

  const attempts = [];
  const byRef = new Map();
  for (const entry of rawAttempts) {
    const ref = entry?.ref ?? entry?.key;
    if (!entry || typeof entry !== 'object' || typeof ref !== 'string' || !entry.value || typeof entry.value !== 'object') {
      throw new ReplayArtifactError('Replay artifact contains an invalid raw attempt', 'replay_attempt_invalid');
    }
    const parsed = parseAttemptRef(ref, session.id);
    if (!parsed) throw new ReplayArtifactError(`Raw attempt reference is outside session ${session.id}`, 'replay_attempt_reference_invalid');
    if (byRef.has(ref) && JSON.stringify(byRef.get(ref)) !== JSON.stringify(entry.value)) {
      throw new ReplayArtifactError(`Raw attempt reference is duplicated with different content: ${ref}`, 'replay_attempt_duplicate');
    }
    const normalized = { ref, segmentId: parsed.segmentId, attempt: parsed.attempt, value: clone(entry.value) };
    byRef.set(ref, normalized.value);
    attempts.push(normalized);
  }

  const planIds = new Set(session.plan.map(item => item.segmentId));
  for (const attempt of attempts) {
    if (!planIds.has(attempt.segmentId)) throw new ReplayArtifactError(`Raw attempt references an unplanned segment: ${attempt.segmentId}`, 'replay_segment_invalid');
  }
  return { version: Number(value?.version) || 1, session: clone(session), rawAttempts: attempts };
}

export function replayArtifactStatus(artifact) {
  const normalized = normalizeReplayArtifact(artifact);
  const bySegment = new Map();
  for (const attempt of normalized.rawAttempts) {
    if (!bySegment.has(attempt.segmentId)) bySegment.set(attempt.segmentId, []);
    bySegment.get(attempt.segmentId).push(attempt);
  }
  const availableSegmentIds = normalized.session.plan
    .filter(item => (bySegment.get(item.segmentId)?.length ?? 0) > 0)
    .map(item => item.segmentId);
  const missingSegmentIds = normalized.session.plan
    .filter(item => !availableSegmentIds.includes(item.segmentId))
    .map(item => item.segmentId);
  return {
    sessionId: normalized.session.id,
    chatId: normalized.session.chatId,
    planCount: normalized.session.plan.length,
    availableSegmentIds,
    missingSegmentIds,
    rawAttemptCount: normalized.rawAttempts.length,
  };
}

function replayError(value) {
  const source = value?.error && typeof value.error === 'object' ? value.error : value;
  const error = new Error(String(source?.message ?? 'Recorded replay attempt failed'));
  for (const [key, nested] of Object.entries(source ?? {})) {
    if (key === 'message') continue;
    try { error[key] = clone(nested); } catch { error[key] = String(nested); }
  }
  error.executionMode = 'replay';
  if (!error.code) error.code = 'replay_recorded_error';
  return error;
}

export class ReplayGenerationAdapter {
  #session;
  #metrics;
  #queues = new Map();

  constructor({ session, rawAttempts = [], metrics = null } = {}) {
    const normalized = normalizeReplayArtifact({ version: 1, session, rawAttempts }, { expectedChatId: session?.chatId });
    this.#session = normalized.session;
    this.#metrics = metrics;
    const rawBySegment = new Map();
    for (const entry of normalized.rawAttempts) {
      // Attempts written by a previous replay are checkpoint metadata, not
      // source material for a second playback pass. The original provider
      // output remains immutable beside them.
      if (entry.value?.executionMode === 'replay') continue;
      if (!rawBySegment.has(entry.segmentId)) rawBySegment.set(entry.segmentId, []);
      rawBySegment.get(entry.segmentId).push(entry);
    }
    for (const item of this.#session.plan) {
      const entries = [...(rawBySegment.get(item.segmentId) ?? [])].sort((a, b) => a.attempt - b.attempt);
      // Provider attempts belong to the historical record, not to this replay
      // cursor. Only attempts produced by a prior replay invocation are
      // consumed; otherwise an imported live session would skip its paid raw
      // output and incorrectly report it as missing.
      const consumed = this.#session.attempts.filter(attempt => attempt.segmentId === item.segmentId && attempt.executionMode === 'replay' && attempt.replaySourceRef).length;
      this.#queues.set(item.segmentId, { item, entries, cursor: Math.min(consumed, entries.length) });
    }
  }

  status() {
    const availableSegmentIds = [];
    const missingSegmentIds = [];
    let availableAttempts = 0;
    for (const [segmentId, queue] of this.#queues) {
      const remaining = Math.max(0, queue.entries.length - queue.cursor);
      if (remaining) availableSegmentIds.push(segmentId); else missingSegmentIds.push(segmentId);
      availableAttempts += remaining;
    }
    return {
      sessionId: this.#session.id,
      chatId: this.#session.chatId,
      planCount: this.#session.plan.length,
      availableSegmentIds,
      missingSegmentIds,
      availableAttemptCount: availableAttempts,
    };
  }

  hasNext(segmentId) {
    const queue = this.#queues.get(segmentId);
    return Boolean(queue && queue.cursor < queue.entries.length);
  }

  async generate({ segmentId, sourceFingerprint } = {}) {
    const queue = this.#queues.get(segmentId);
    if (!queue) throw new ReplayUnavailableError(`No replay plan exists for segment ${segmentId}`, { segmentId, sourceFingerprint });
    if (queue.item.source?.rangeFingerprint !== sourceFingerprint) {
      throw new ReplayArtifactError(`Replay source fingerprint does not match segment ${segmentId}`, 'replay_source_mismatch');
    }
    const entry = queue.entries[queue.cursor++];
    if (!entry) throw new ReplayUnavailableError(`No recorded attempt remains for segment ${segmentId}`, { segmentId, sourceFingerprint });
    const blob = entry.value;
    const finish = this.#metrics?.measure('memory_generation', { route: 'replay', executionMode: 'replay', segmentId });
    if (blob.error) {
      const error = replayError(blob);
      error.usage = clone(blob.usage ?? blob.rawResponse?.usage ?? null);
      error.requestId = blob.requestId ?? blob.rawResponse?.id ?? null;
      error.model = blob.model ?? blob.rawResponse?.model ?? this.#session.config?.model ?? null;
      error.finishReason = blob.finishReason ?? blob.rawResponse?.choices?.[0]?.finish_reason ?? null;
      error.rawResponse = clone(blob.rawResponse ?? blob.raw ?? null);
      error.replayRef = entry.ref;
      finish?.({ status: 'failed', executionMode: 'replay' });
      throw error;
    }
    if (typeof blob.text !== 'string') {
      finish?.({ status: 'failed', executionMode: 'replay' });
      throw new ReplayArtifactError(`Recorded attempt ${entry.ref} has no response text`, 'replay_response_missing');
    }
    const usage = blob.usage ? clone(blob.usage) : normalizeProviderUsage(blob.rawResponse?.usage);
    finish?.({ status: 'success', executionMode: 'replay', outputCharacters: blob.text.length, ...(usage ?? {}) });
    return {
      text: blob.text,
      usage,
      raw: clone(blob.rawResponse ?? blob.raw ?? null),
      requestId: blob.requestId ?? blob.rawResponse?.id ?? null,
      model: blob.model ?? blob.rawResponse?.model ?? this.#session.config?.model ?? null,
      finishReason: blob.finishReason ?? blob.rawResponse?.choices?.[0]?.finish_reason ?? null,
      executionMode: 'replay',
      replayRef: entry.ref,
    };
  }
}

export class OfflineGenerationAdapter {
  async generate({ segmentId = null, sourceFingerprint = null } = {}) {
    throw new ReplayUnavailableError('Offline mode does not generate new memory', { segmentId, sourceFingerprint });
  }
}

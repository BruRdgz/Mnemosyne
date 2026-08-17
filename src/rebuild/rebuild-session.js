import { fingerprintValue } from '../domain/fingerprint.js';
import { fnv1a64 } from '../domain/ids.js';
import { validateMemorySegment } from '../domain/schema.js';

export const REBUILD_SESSION_STATUSES = Object.freeze(['planned', 'running', 'incomplete', 'complete', 'promoted']);

export function rebuildConfigFingerprint(config) {
  return fingerprintValue(config ?? {}, 'rebuild-config');
}

export function baselineFingerprint(segments = []) {
  return fingerprintValue(segments.map(segment => ({ id: segment.id, source: segment.source?.rangeFingerprint, status: segment.status, updatedAt: segment.updatedAt })), 'rebuild-baseline');
}

export function createRebuildSession({ chatId, mode = 'rebuild', plan, baselineSegments = [], config = {}, pricing, now = Date.now() }) {
  if (!Array.isArray(plan) || !plan.length) throw new TypeError('Rebuild session requires a non-empty plan');
  const sourceFingerprint = fingerprintValue(plan.map(item => item.source?.rangeFingerprint), 'rebuild-source');
  const configFingerprint = rebuildConfigFingerprint(config);
  const id = `rb_${fnv1a64(`${chatId}:${sourceFingerprint}:${configFingerprint}:${now}`)}`;
  return Object.freeze({
    id,
    chatId: String(chatId),
    mode,
    status: 'planned',
    createdAt: now,
    updatedAt: now,
    baselineFingerprint: baselineFingerprint(baselineSegments),
    sourceFingerprint,
    configFingerprint,
    config: structuredClone(config),
    pricing: structuredClone(pricing),
    plan: plan.map(item => ({
      segmentId: item.id,
      source: structuredClone(item.source),
      sourceTokenCount: item.sourceTokenCount,
      boundaryReason: item.boundaryReason,
      oversized: Boolean(item.oversized),
      status: item.status === 'valid' || item.reused ? 'valid' : 'pending',
      reused: Boolean(item.reused),
      reusedFromSegmentId: item.reusedFromSegmentId ?? null,
      reusedFromSessionId: item.reusedFromSessionId ?? null,
      projectedInputTokens: Number.isFinite(item.projectedInputTokens) ? item.projectedInputTokens : null,
      expectedOutputTokens: Number.isFinite(item.expectedOutputTokens) ? item.expectedOutputTokens : null,
      expectedAttempts: Number.isFinite(item.expectedAttempts) ? item.expectedAttempts : null,
      expectedWallTimeMs: Number.isFinite(item.expectedWallTimeMs) ? item.expectedWallTimeMs : null,
      bundleCount: Number.isFinite(item.bundleCount) ? item.bundleCount : item.source?.turnBundles?.length ?? null,
    })),
    segments: [],
    attempts: [],
    promotedAt: null,
  });
}

export function validateRebuildSession(session, { expectedChatId } = {}) {
  const errors = [];
  if (!session || typeof session !== 'object' || Array.isArray(session)) errors.push('session must be an object');
  else {
    if (!/^rb_[0-9a-f]{16}$/.test(session.id ?? '')) errors.push('session id is invalid');
    if (expectedChatId !== undefined && String(session.chatId) !== String(expectedChatId)) errors.push('session belongs to another chat');
    if (!REBUILD_SESSION_STATUSES.includes(session.status)) errors.push('session status is invalid');
    if (!Array.isArray(session.plan) || !session.plan.length) errors.push('session plan is required');
    if (!Array.isArray(session.segments)) errors.push('session segments must be an array');
    else for (const segment of session.segments) {
      const result = validateMemorySegment(segment);
      if (!result.ok) errors.push(...result.errors.map(error => `segment ${segment?.id ?? '?'}: ${error}`));
    }
    if (!Array.isArray(session.attempts)) errors.push('session attempts must be an array');
    for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(session[field])) errors.push(`${field} is required`);
  }
  if (errors.length) throw new TypeError(`Invalid rebuild session: ${errors.join('; ')}`);
  return structuredClone(session);
}

export function summarizeRebuildSession(session) {
  const counts = Object.fromEntries(['pending', 'valid', 'failed', 'stale'].map(status => [status, session.plan.filter(item => item.status === status).length]));
  return { id: session.id, status: session.status, ...counts, attempts: session.attempts.length, createdAt: session.createdAt, updatedAt: session.updatedAt };
}

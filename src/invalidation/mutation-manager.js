import { fingerprintValue } from '../domain/fingerprint.js';

function covers(segment, messageIndex) {
  const first = segment.source?.first?.messageIndex;
  const last = segment.source?.last?.messageIndex;
  return Number.isInteger(first) && Number.isInteger(last) && first <= messageIndex && last >= messageIndex;
}

function cloneSegments(segments) {
  return segments.map(segment => structuredClone(segment));
}

export class MutationManager {
  #metrics;
  #branches = new Map();

  constructor({ metrics = null } = {}) {
    this.#metrics = metrics;
  }

  handleEdit(segments, messageIndex) {
    return this.#invalidate(segments, messageIndex, 'edit');
  }

  handleDelete(segments, messageIndex) {
    const result = this.#invalidate(segments, messageIndex, 'delete');
    for (const segment of result.segments) {
      const source = segment.source;
      if (!source) continue;
      if (source.first.messageIndex > messageIndex) source.first.messageIndex -= 1;
      if (source.last.messageIndex > messageIndex) source.last.messageIndex -= 1;
      if (source.first.messageIndex > source.last.messageIndex) source.first.messageIndex = source.last.messageIndex;
    }
    result.replanned = true;
    return result;
  }

  handleSwipe(segments, { messageIndex, previousFingerprint = null, activeFingerprint }) {
    if (previousFingerprint) this.#branches.set(this.#branchKey(messageIndex, previousFingerprint), cloneSegments(segments));
    const cached = this.#branches.get(this.#branchKey(messageIndex, activeFingerprint));
    if (cached) {
      const result = { segments: cloneSegments(cached), cacheHit: true, staleCount: 0, visitedCount: 0, dependencyCount: 0, eagerExtractionCalls: 0 };
      this.#metrics?.record({ operation: 'branch_select', status: 'cache_hit', messageIndex, artifactCount: cached.length, eagerExtractionCalls: 0 });
      return result;
    }
    const result = { ...this.#invalidate(segments, messageIndex, 'swipe'), cacheHit: false };
    this.#metrics?.record({ operation: 'branch_select', status: 'cache_miss', messageIndex, artifactCount: result.segments.length, eagerExtractionCalls: 0 });
    return result;
  }

  storeBranch(messageIndex, activeFingerprint, segments) {
    this.#branches.set(this.#branchKey(messageIndex, activeFingerprint), cloneSegments(segments));
  }

  branchCount() { return this.#branches.size; }

  #branchKey(messageIndex, fingerprint) {
    return fingerprintValue({ messageIndex, fingerprint }, 'swipe-branch');
  }

  #invalidate(segments, messageIndex, reason) {
    const startedAt = performance.now();
    const next = cloneSegments(segments);
    const staleIds = new Set();
    const queue = [];
    let earliestAffected = Infinity;
    for (const segment of next) {
      if (covers(segment, messageIndex)) {
        staleIds.add(segment.id);
        queue.push(segment.id);
        earliestAffected = Math.min(earliestAffected, segment.source.first.messageIndex);
      }
    }
    // State/checkpoint derivation is ordered, so later segments form a conservative stale suffix.
    if (earliestAffected !== Infinity) {
      for (const segment of next) {
        if ((segment.source?.first?.messageIndex ?? -1) >= earliestAffected && !staleIds.has(segment.id)) {
          staleIds.add(segment.id);
          queue.push(segment.id);
        }
      }
    }
    let dependencyCount = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const staleId = queue[cursor];
      for (const segment of next) {
        const dependencies = segment.dependencyIds ?? segment.dependencies ?? segment.summary?.dependencies ?? [];
        if (!dependencies.includes(staleId) || staleIds.has(segment.id)) continue;
        staleIds.add(segment.id);
        queue.push(segment.id);
        dependencyCount += 1;
      }
    }
    for (const segment of next) {
      if (!staleIds.has(segment.id) || segment.status === 'excluded') continue;
      segment.status = 'stale';
      segment.staleReason = reason;
    }
    const result = {
      segments: next,
      visitedCount: next.length,
      staleCount: staleIds.size,
      dependencyCount,
      eagerExtractionCalls: 0,
      invalidatedIds: [...staleIds],
    };
    this.#metrics?.record({ operation: 'source_invalidation', status: 'success', reason, messageIndex, durationMs: performance.now() - startedAt, visitedCount: result.visitedCount, staleCount: result.staleCount, dependencyCount, eagerExtractionCalls: 0 });
    return result;
  }
}

export class PendingJobGuard {
  #jobs = new Map();

  begin({ jobId, chatId, sourceFingerprint }) {
    const token = Object.freeze({ jobId: String(jobId), chatId: String(chatId), sourceFingerprint: String(sourceFingerprint) });
    this.#jobs.set(token.jobId, token);
    return token;
  }

  canCommit(token, { chatId, sourceFingerprint }) {
    const active = this.#jobs.get(token?.jobId);
    return active === token && token.chatId === String(chatId) && token.sourceFingerprint === String(sourceFingerprint);
  }

  finish(token) {
    if (this.#jobs.get(token?.jobId) === token) this.#jobs.delete(token.jobId);
  }

  cancelChat(chatId) {
    let cancelled = 0;
    for (const [jobId, token] of this.#jobs) if (token.chatId === String(chatId)) { this.#jobs.delete(jobId); cancelled += 1; }
    return cancelled;
  }
}

export function activeInjectableSegments(segments, activeSourceFingerprints = null) {
  const allowed = activeSourceFingerprints ? new Set(activeSourceFingerprints) : null;
  return segments.filter(segment => segment.status === 'valid'
    && segment.extraction?.replacementEligible !== false
    && (!allowed || allowed.has(segment.source?.rangeFingerprint)));
}

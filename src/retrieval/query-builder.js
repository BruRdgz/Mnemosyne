import { normalizeAlias } from '../entities/entity-registry.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'who', 'why', 'with', 'you', 'your',
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractTerms(parts, limit) {
  const counts = new Map();
  for (const token of normalizeAlias(parts.filter(Boolean).join(' ')).split(' ')) {
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([term]) => term);
}

export class RetrievalQueryBuilder {
  #assistant;
  #metrics;

  constructor({ assistant = null, metrics = null } = {}) {
    this.#assistant = assistant;
    this.#metrics = metrics;
  }

  async build(input = {}, { allowModelAssistance = false, maxTerms = 32 } = {}) {
    const finish = this.#metrics?.measure('retrieval_query_build', { modelAssisted: Boolean(allowModelAssistance && this.#assistant) });
    const entityNames = (input.entities ?? []).flatMap(entity => [entity.name, entity.canonicalName, ...(entity.aliases ?? [])]);
    const threads = unique((input.activeThreads ?? []).map(item => typeof item === 'string' ? item : item.key));
    const commitments = unique((input.activeCommitments ?? [])
      .filter(item => typeof item === 'string' || item?.status === undefined || ['made', 'active', 'unknown'].includes(item?.status))
      .map(item => typeof item === 'string' ? item : (item.id ?? item.content)));
    const registers = unique((input.activeRegisters ?? []).map(item => typeof item === 'string' ? item : item.key));
    const activeEntityIds = Array.isArray(input.activeEntityIds)
      ? input.activeEntityIds
      : (input.entities ?? []).map(entity => entity.id);
    const participantEntityIds = Array.isArray(input.participantEntityIds) ? input.participantEntityIds : activeEntityIds;
    const deterministic = {
      terms: extractTerms([input.currentUserMessage, ...(input.rawTail ?? []).map(item => item.text ?? item.mes), ...entityNames, ...threads, ...commitments, ...registers], maxTerms),
      entityIds: unique(activeEntityIds),
      participantEntityIds: unique(participantEntityIds),
      activeSpeakerEntityId: input.activeSpeakerEntityId ?? null,
      threads,
      commitments,
      registers,
      builder: 'deterministic',
    };
    if (!allowModelAssistance || !this.#assistant) {
      finish?.({ status: 'success', termCount: deterministic.terms.length, entityCount: deterministic.entityIds.length });
      return deterministic;
    }
    try {
      const additions = await this.#assistant(structuredClone(deterministic), structuredClone(input));
      const result = {
        terms: unique([...deterministic.terms, ...((additions?.terms ?? []).map(normalizeAlias))]).slice(0, maxTerms),
        entityIds: unique([...deterministic.entityIds, ...(additions?.entityIds ?? [])]),
        participantEntityIds: unique([...deterministic.participantEntityIds, ...(additions?.participantEntityIds ?? [])]),
        activeSpeakerEntityId: additions?.activeSpeakerEntityId ?? deterministic.activeSpeakerEntityId,
        threads: unique([...deterministic.threads, ...(additions?.threads ?? [])]),
        commitments: unique([...deterministic.commitments, ...(additions?.commitments ?? [])]),
        registers: unique([...deterministic.registers, ...(additions?.registers ?? [])]),
        builder: 'model-assisted',
      };
      finish?.({ status: 'success', termCount: result.terms.length, entityCount: result.entityIds.length });
      return result;
    } catch {
      finish?.({ status: 'fallback', termCount: deterministic.terms.length, entityCount: deterministic.entityIds.length });
      return deterministic;
    }
  }
}

import { fingerprintValue } from '../domain/fingerprint.js';
import { cosineSimilarity } from './embedding-adapter.js';

function intersects(left = [], right = []) {
  const wanted = new Set(right);
  return left.filter(value => wanted.has(value));
}

export class HybridRetriever {
  #lexical;
  #embeddings;
  #metrics;

  constructor({ lexicalIndex, embeddingAdapter = null, metrics = null }) {
    if (!lexicalIndex) throw new TypeError('HybridRetriever requires a lexical index');
    this.#lexical = lexicalIndex;
    this.#embeddings = embeddingAdapter;
    this.#metrics = metrics;
  }

  async retrieve(query, artifacts, { limit = 5, lexicalWeight = 1, semanticWeight = 0.75, exactBoost = 2, recencyWeight = 0.15, recencyHalfLifeMessages = 200 } = {}) {
    const started = performance.now();
    const lexicalStarted = performance.now();
    const lexicalResults = this.#lexical.search(query, { limit: Math.max(limit * 8, artifacts.length) });
    const lexicalLatencyMs = performance.now() - lexicalStarted;
    const candidates = new Map(artifacts.map(artifact => [artifact.id, {
      id: artifact.id,
      artifact,
      lexicalScore: 0,
      semanticScore: 0,
      boostScore: 0,
      reasons: [],
    }]));
    for (const result of lexicalResults) {
      const candidate = candidates.get(result.id);
      if (!candidate) continue;
      candidate.lexicalScore = result.score;
      candidate.document = result.document;
      if (result.matchedTerms.length) candidate.reasons.push({ kind: 'lexical', scoring: result.scoring ?? 'term-frequency', matches: result.matchedTerms });
    }

    const semanticStarted = performance.now();
    let semanticAvailable = false;
    if (this.#embeddings?.available) {
      const queryVector = await this.#embeddings.embedQuery(query);
      if (queryVector) {
        semanticAvailable = true;
        for (const candidate of candidates.values()) {
          const vector = await this.#embeddings.embedArtifact({ fingerprint: candidate.artifact.fingerprint ?? fingerprintValue(candidate.artifact.id, 'artifact'), text: candidate.artifact.text ?? '' });
          candidate.semanticScore = Math.max(0, cosineSimilarity(queryVector, vector));
          if (candidate.semanticScore > 0) candidate.reasons.push({ kind: 'semantic', score: candidate.semanticScore });
        }
      }
    }
    const semanticLatencyMs = performance.now() - semanticStarted;

    const maximumLastIndex = Math.max(0, ...[...candidates.values()].map(candidate => Number((candidate.document ?? candidate.artifact.document ?? {}).lastIndex) || 0));
    for (const candidate of candidates.values()) {
      const document = candidate.document ?? candidate.artifact.document ?? {};
      const matches = {
        entity: intersects(document.entities, query.entityIds),
        thread: intersects(document.threads, query.threads),
        commitment: intersects(document.commitments, query.commitments),
        register: intersects(document.registers, query.registers),
      };
      for (const [kind, values] of Object.entries(matches)) {
        if (!values.length) continue;
        const weight = kind === 'thread' || kind === 'commitment' ? exactBoost : exactBoost * 0.75;
        candidate.boostScore += weight * values.length;
        candidate.reasons.push({ kind: `${kind}-match`, matches: values, score: weight * values.length });
      }
      if (query.activeSpeakerEntityId && document.entities?.includes(query.activeSpeakerEntityId)) {
        const weight = exactBoost * 0.5;
        candidate.boostScore += weight;
        candidate.reasons.push({ kind: 'active-speaker-match', matches: [query.activeSpeakerEntityId], score: weight });
      }
      const participantMatches = intersects(document.entities, query.participantEntityIds);
      if (participantMatches.length) {
        const weight = exactBoost * 0.25 * participantMatches.length;
        candidate.boostScore += weight;
        candidate.reasons.push({ kind: 'active-participant-match', matches: participantMatches, score: weight });
      }
      const baseScore = candidate.lexicalScore * lexicalWeight + candidate.semanticScore * semanticWeight + candidate.boostScore;
      candidate.recencyScore = 0;
      if (baseScore > 0 && recencyWeight > 0 && Number.isFinite(Number(document.lastIndex))) {
        const age = Math.max(0, maximumLastIndex - Number(document.lastIndex));
        candidate.recencyScore = 1 / (1 + age / Math.max(1, recencyHalfLifeMessages));
        candidate.reasons.push({ kind: 'bounded-recency', ageMessages: age, score: candidate.recencyScore * recencyWeight });
      }
      candidate.score = baseScore + candidate.recencyScore * recencyWeight;
    }
    const selected = [...candidates.values()].filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
      .map(({ artifact, document, ...candidate }) => ({ ...candidate, mode: semanticAvailable ? 'hybrid' : 'lexical' }));
    this.#metrics?.record({
      operation: 'retrieval',
      status: 'success',
      mode: semanticAvailable ? 'hybrid' : 'lexical',
      corpusCount: artifacts.length,
      candidateCount: [...candidates.values()].filter(candidate => candidate.score > 0).length,
      selectedCount: selected.length,
      lexicalLatencyMs,
      semanticLatencyMs,
      durationMs: performance.now() - started,
    });
    return selected;
  }
}

export function retrievalQuality(fixtures, { k = 5 } = {}) {
  let recall = 0; let precision = 0; let reciprocalRank = 0;
  for (const fixture of fixtures) {
    const expected = new Set(fixture.relevantIds);
    const selected = fixture.resultIds.slice(0, k);
    const hits = selected.filter(id => expected.has(id));
    recall += expected.size ? hits.length / expected.size : 1;
    precision += selected.length ? hits.length / selected.length : 0;
    const first = selected.findIndex(id => expected.has(id));
    reciprocalRank += first < 0 ? 0 : 1 / (first + 1);
  }
  const divisor = fixtures.length || 1;
  return { k, fixtureCount: fixtures.length, recallAtK: recall / divisor, precisionAtK: precision / divisor, mrr: reciprocalRank / divisor };
}

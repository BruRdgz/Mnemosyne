import { normalizeAlias } from '../entities/entity-registry.js';

function terms(text) {
  return normalizeAlias(text).split(' ').filter(token => token.length > 1);
}

function scalarText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, scalarText(item)]).filter(Boolean).join(' ');
  return '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function activeCommitments(summary) {
  return (summary.commitments ?? []).filter(item => ['made', 'active', 'unknown'].includes(item?.transition));
}

function semanticText(segment) {
  const summary = segment.summary ?? {};
  const commitments = activeCommitments(summary);
  return [
    summary.synopsis,
    ...(summary.events ?? []).map(item => item.description),
    ...(summary.observations ?? []).flatMap(item => [item.description, item.predicate, item.subject, scalarText(item.value)]),
    ...(summary.stateChanges ?? []).flatMap(item => [item.subject, item.path, item.operation, scalarText(item.value)]),
    ...(summary.knowledgeChanges ?? []).flatMap(item => [item.holder, item.proposition, item.kind, item.operation]),
    ...(summary.relationshipChanges ?? []).flatMap(item => [...(item.participants ?? []), item.dimension, item.operation, scalarText(item.value)]),
    ...(summary.threads ?? []).flatMap(item => [item.key, item.description]),
    ...commitments.flatMap(item => [item.actor, item.toward, item.content, item.transition]),
    ...(summary.salientNegatives ?? []).flatMap(item => [item.proposition, item.reason]),
    ...(summary.registerObservations ?? []).flatMap(item => [item.registerKey, item.eventKey, item.subject, scalarText(item.entries), scalarText(item.values)]),
    ...(summary.interpretations ?? []).map(item => item.description),
    ...(summary.temporal ?? []).flatMap(item => [item.description, item.kind]),
    ...(summary.locations ?? []).flatMap(item => [item.subject, item.location, item.kind]),
    ...(summary.entities ?? []).flatMap(item => [item.mention, item.canonicalNameCandidate, ...(item.aliases ?? [])]),
  ].filter(Boolean).join(' ');
}

function semanticEntityReferences(summary) {
  const commitments = activeCommitments(summary);
  return unique([
    ...(summary.entities ?? []).flatMap(item => [item.proposedEntityId, item.entityId]),
    ...(summary.stateChanges ?? []).map(item => item.subject),
    ...(summary.knowledgeChanges ?? []).map(item => item.holder),
    ...(summary.relationshipChanges ?? []).flatMap(item => item.participants ?? []),
    ...commitments.flatMap(item => [item.actor, item.toward]),
    ...(summary.locations ?? []).map(item => item.subject),
  ]);
}

export class LexicalIndex {
  #documents = new Map();
  #metrics;

  constructor({ metrics = null } = {}) {
    this.#metrics = metrics;
  }

  add(segment) {
    const summary = segment.summary ?? {};
    const commitments = activeCommitments(summary);
    const text = semanticText(segment);
    const frequencies = {};
    for (const term of terms(text)) frequencies[term] = (frequencies[term] ?? 0) + 1;
    const length = Object.values(frequencies).reduce((sum, count) => sum + count, 0);
    this.#documents.set(segment.id, {
      id: segment.id,
      firstIndex: segment.source?.first?.messageIndex ?? segment.firstIndex,
      lastIndex: segment.source?.last?.messageIndex ?? segment.lastIndex,
      frequencies,
      length,
      entities: semanticEntityReferences(summary),
      threads: unique((summary.threads ?? []).map(item => item.key)),
      commitments: unique(commitments.map(item => item.id ?? item.content)),
      registers: unique((summary.registerObservations ?? []).map(item => item.registerKey)),
      locations: unique((summary.locations ?? []).map(item => item.location)),
      knowledge: unique((summary.knowledgeChanges ?? []).map(item => `${item.holder}:${item.proposition}`)),
      relationships: unique((summary.relationshipChanges ?? []).map(item => `${[...(item.participants ?? [])].sort().join('|')}:${item.dimension}`)),
      negatives: unique((summary.salientNegatives ?? []).map(item => item.proposition)),
      temporal: unique((summary.temporal ?? []).map(item => item.description)),
    });
  }

  rebuild(segments) {
    const finish = this.#metrics?.measure('lexical_index_rebuild', { inputCount: segments.length });
    this.#documents.clear();
    for (const segment of segments) if (segment.status === 'valid' && segment.summary) this.add(segment);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(this.serialize())).length;
    finish?.({ status: 'success', documentCount: this.#documents.size, serializedBytes });
    return { documentCount: this.#documents.size, serializedBytes };
  }

  search(query, { limit = 20, k1 = 1.2, b = 0.75 } = {}) {
    const queryTerms = [...new Set(terms(typeof query === 'string' ? query : (query.terms ?? []).join(' ')))];
    const documents = [...this.#documents.values()];
    const averageLength = documents.length
      ? documents.reduce((sum, document) => sum + (document.length ?? Object.values(document.frequencies ?? {}).reduce((total, count) => total + count, 0)), 0) / documents.length
      : 0;
    const documentFrequency = Object.fromEntries(queryTerms.map(term => [term, documents.filter(document => document.frequencies?.[term]).length]));
    return documents.map(document => {
      let score = 0;
      const matchedTerms = [];
      const documentLength = document.length ?? Object.values(document.frequencies ?? {}).reduce((sum, count) => sum + count, 0);
      for (const term of queryTerms) {
        const frequency = document.frequencies?.[term] ?? 0;
        if (frequency) {
          const frequencyInCorpus = documentFrequency[term] ?? 0;
          const inverseDocumentFrequency = Math.log(1 + (documents.length - frequencyInCorpus + 0.5) / (frequencyInCorpus + 0.5));
          const lengthNormalization = frequency + k1 * (1 - b + b * (documentLength / Math.max(1, averageLength)));
          score += inverseDocumentFrequency * ((frequency * (k1 + 1)) / lengthNormalization);
          matchedTerms.push(term);
        }
      }
      return { id: document.id, score, matchedTerms, document: structuredClone(document), scoring: 'bm25' };
    }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }

  byThread(key) { return this.#byField('threads', key); }
  byCommitment(key) { return this.#byField('commitments', key); }
  byRegister(key) { return this.#byField('registers', key); }
  byEntity(id) { return this.#byField('entities', id); }
  byLocation(location) { return this.#byField('locations', location); }

  #byField(field, value) {
    return [...this.#documents.values()].filter(document => document[field].includes(value)).map(document => document.id);
  }

  serialize() {
    return [...this.#documents.values()].map(document => structuredClone(document));
  }

  hydrate(documents) {
    this.#documents = new Map(documents.map(document => [document.id, {
      ...structuredClone(document),
      length: document.length ?? Object.values(document.frequencies ?? {}).reduce((sum, count) => sum + count, 0),
    }]));
  }

  get size() { return this.#documents.size; }
}

import { fnv1a64 } from '../domain/ids.js';

const VAGUE_THREADS = new Set(['love', 'life', 'drama', 'tension']);

function relationshipKey(participants) {
  return [...participants].sort().join('|');
}

function commitmentKey(change) {
  return `commit_${fnv1a64(`${change.actor}|${change.toward ?? ''}|${change.content}`)}`;
}

function ensureCharacter(state, entityId) {
  if (!state.characters[entityId]) {
    state.characters[entityId] = {
      entityId,
      currentCondition: {},
      learnedAttributes: {},
      preferences: {},
      ongoingActivities: {},
      possessions: {},
      knowledge: {},
      commitments: {},
      localThreads: {},
    };
  }
  return state.characters[entityId];
}

function setPath(target, path, value) {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return;
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[part] = existing === undefined ? {} : { _value: structuredClone(existing) };
    }
    cursor = cursor[part];
  }
  const leaf = parts.at(-1);
  const existing = cursor[leaf];
  if (existing && typeof existing === 'object' && !Array.isArray(existing) && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    existing._value = structuredClone(value);
  } else cursor[leaf] = structuredClone(value);
}

function removePath(target, path) {
  const parts = path.split('.').filter(Boolean);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor?.[part];
    if (!cursor || typeof cursor !== 'object') return;
  }
  delete cursor[parts.at(-1)];
}

export class NarrativeStateReducer {
  #state;
  #history = [];
  #preferenceEvidence = new Map();

  constructor({ cardCanon = {}, initialState = null } = {}) {
    this.#state = initialState ? structuredClone(initialState) : {
      characters: {}, relationships: {}, worldFacts: {}, narratorFacts: {},
      commitments: {}, threads: {}, salientNegatives: [],
      upstreamCanon: structuredClone(cardCanon),
    };
  }

  applyEpisode(summary, { segmentId = null } = {}) {
    const deltaRecord = { segmentId, summary: structuredClone(summary) };
    this.#history.push(deltaRecord);

    for (const change of summary.stateChanges ?? []) this.#applyStateChange(change);
    for (const observation of summary.observations ?? []) this.#applyObservation(observation);
    for (const change of summary.knowledgeChanges ?? []) this.#applyKnowledge(change);
    for (const change of summary.relationshipChanges ?? []) this.#applyRelationship(change);
    for (const change of summary.commitments ?? []) this.#applyCommitment(change);
    for (const change of summary.threads ?? []) this.#applyThread(change);
    for (const negative of summary.salientNegatives ?? []) this.#applyNegative(negative, segmentId);
    return this.snapshot();
  }

  #applyStateChange(change) {
    const character = ensureCharacter(this.#state, change.subject);
    const root = String(change.path).split('.')[0];
    if (root === 'identity' && change.evidence !== 'explicit') return;
    if (root === 'preferences') {
      const key = `${change.subject}:${change.path}:${JSON.stringify(change.value)}`;
      const seen = (this.#preferenceEvidence.get(key) ?? 0) + 1;
      this.#preferenceEvidence.set(key, seen);
      const strongEnough = change.evidence === 'explicit' || (change.evidence === 'strong_inference' && seen >= 2);
      if (!strongEnough || change.persistence !== 'durable') return;
    }
    if (root === 'possessions') {
      const relevant = change.persistence === 'durable' || change.persistence === 'active' || change.value?.continuityRelevant === true;
      if (!relevant || change.evidence === 'weak_inference') return;
    }
    if (change.operation === 'remove') removePath(character, change.path);
    else setPath(character, change.path, change.value);
  }

  #applyObservation(observation) {
    const scope = observation.epistemicScope;
    const key = observation.predicate ?? observation.description;
    if (scope === 'world') this.#state.worldFacts[key] = structuredClone(observation);
    if (scope === 'narrator') this.#state.narratorFacts[key] = structuredClone(observation);
  }

  #applyKnowledge(change) {
    const character = ensureCharacter(this.#state, change.holder);
    if (change.operation === 'remove') delete character.knowledge[change.proposition];
    else character.knowledge[change.proposition] = { kind: change.kind, evidence: change.evidence };
  }

  #applyRelationship(change) {
    const key = relationshipKey(change.participants);
    const relationship = this.#state.relationships[key] ??= { participants: [...change.participants] };
    if (change.operation === 'remove') delete relationship[change.dimension];
    else if (change.operation === 'add') {
      const current = Array.isArray(relationship[change.dimension]) ? relationship[change.dimension] : [];
      relationship[change.dimension] = [...current, structuredClone(change.value)];
    } else relationship[change.dimension] = structuredClone(change.value);
  }

  #applyCommitment(change) {
    const id = change.id ?? commitmentKey(change);
    const current = this.#state.commitments[id] ?? { id, actor: change.actor, toward: change.toward, content: change.content };
    current.status = change.transition === 'made' ? 'active' : change.transition;
    current.evidence = change.evidence;
    this.#state.commitments[id] = current;
    ensureCharacter(this.#state, change.actor).commitments[id] = current.status;
  }

  #applyThread(change) {
    const vague = VAGUE_THREADS.has(String(change.key).toLowerCase()) || VAGUE_THREADS.has(String(change.description).toLowerCase());
    if (vague) return;
    this.#state.threads[change.key] = {
      key: change.key,
      description: change.description,
      status: change.transition === 'advanced' ? 'active' : change.transition,
      evidence: change.evidence,
    };
  }

  #applyNegative(negative, segmentId) {
    if (negative.continuityRelevant === false) return;
    const contrastive = negative.contrastive === true || /(attempt|explicit|refus|reject|did not|not occur|disqualif|without)/i.test(negative.reason);
    if (!contrastive) return;
    const key = String(negative.proposition).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (this.#state.salientNegatives.some(item => item.key === key)) return;
    this.#state.salientNegatives.push({ key, ...structuredClone(negative), segmentId });
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  history() {
    return structuredClone(this.#history);
  }
}

export { commitmentKey, relationshipKey };

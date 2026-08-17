import { EntityRegistry, normalizeAlias } from '../entities/entity-registry.js';
import { ENTITY_ID_PATTERN, entityIdFromSeed } from '../domain/ids.js';
import {
  ChangeOperation,
  CommitmentStatus,
  EpistemicKind,
  LocationEvidenceKind,
  MemoryDomain,
  ModelEvidenceLevel,
  RelationshipDimension,
  Salience,
  TemporalEvidenceKind,
} from '../domain/enums.js';

const THREAD_TRANSITION_ALIASES = Object.freeze({
  opened: 'open',
  progressed: 'advanced',
  completed: 'resolved',
  closed: 'resolved',
  'still-open': 'active',
  initiated: 'open',
  maintained: 'active',
});

const DOMAIN_ALIASES = Object.freeze({
  boundary: 'relationship',
});

const TEMPORAL_KIND_ALIASES = Object.freeze({
  historical: 'relative',
  scene_timestamp: 'exact',
  timestamp: 'exact',
  elapsed: 'relative',
  'time-marker': 'exact',
  scene_time: 'exact',
  'scene-time': 'exact',
  'time-of-day': 'exact',
});

const SALIENCE_ALIASES = Object.freeze({ low: 'minor', medium: 'normal', moderate: 'normal', high: 'important' });
const KNOWLEDGE_KIND_ALIASES = Object.freeze({ fact: 'knows', confirmed_fact: 'knows', observes: 'knows', interpersonal: 'knows', character: 'knows', assessment: 'believes', 'character-assessment': 'believes', character_insight: 'believes', interpretation: 'believes' });
const KNOWLEDGE_OPERATION_ALIASES = Object.freeze({ confirmed: 'add', learned: 'add', learn: 'add', establish: 'add', established: 'add', formed: 'add', set: 'add', updated: 'revise' });
const PROVIDER_KNOWLEDGE_KIND_ALIASES = Object.freeze({ observation: 'knows' });
const PROVIDER_KNOWLEDGE_OPERATION_ALIASES = Object.freeze({ update: 'revise', maintain: 'revise', observe: 'add' });
const PROVIDER_STATE_OPERATION_ALIASES = Object.freeze({ increase: 'revise', decrease: 'revise', increment: 'revise', decrement: 'revise', persist: 'set', preserve: 'set' });
const PROVIDER_RELATIONSHIP_DIMENSION_ALIASES = Object.freeze({ physical_comfort: 'physical_affection', rapport: 'emotional_closeness', 'mutual respect': 'trust', recognition: 'trust' });
const PROVIDER_CHANGE_OPERATION_ALIASES = Object.freeze({ established: 'set' });
const PROVIDER_TEMPORAL_KIND_ALIASES = Object.freeze({ timer: 'exact' });
const PROVIDER_LOCATION_KIND_ALIASES = Object.freeze({ sublocation: 'scene', referenced: 'scene' });
const PROVIDER_PERSISTENCE_ALIASES = Object.freeze({ stable: 'durable', episodic: 'transient', situational: 'transient', ongoing: 'active' });
const COMMITMENT_TRANSITION_ALIASES = Object.freeze({ open: 'active', opened: 'active', initiated: 'made', advanced: 'made', created: 'made', fulfilled: 'kept', completed: 'kept', satisfied: 'kept', expired: 'obsolete', not_triggered: 'obsolete', pending: 'active', unresolved: 'active' });
const LOCATION_KIND_ALIASES = Object.freeze({ travel_route: 'scene', origin_point: 'scene', arrival_point: 'scene', indoor: 'scene', interior: 'scene', estate: 'scene', primary: 'scene', room: 'scene', transit: 'scene', 'prior-scene': 'scene', present: 'presence' });
const PERSISTENCE_ALIASES = Object.freeze({ session: 'active', current: 'active', pending: 'active', permanent: 'durable', persistent: 'durable', scene: 'transient', ephemeral: 'transient', temporary: 'transient' });
const SUMMARY_ARRAY_FIELDS = Object.freeze(['entities', 'events', 'observations', 'stateChanges', 'knowledgeChanges', 'relationshipChanges', 'commitments', 'threads', 'salientNegatives', 'registerObservations', 'interpretations', 'temporal', 'locations']);
const OMITTABLE_EMPTY_FIELDS = Object.freeze(['registerObservations', 'interpretations']);
const REQUIRED_ITEM_KEY = Object.freeze({ entities: 'mention', events: 'description', observations: 'description', stateChanges: 'subject', knowledgeChanges: 'holder', relationshipChanges: 'participants', commitments: 'actor', threads: 'key', salientNegatives: 'proposition', registerObservations: 'kind', interpretations: 'description', temporal: 'description', locations: 'location' });

function normalizeEvidence(value, { inference = false } = {}) {
  if (ModelEvidenceLevel.has(value)) return inference && value === 'explicit' ? 'strong_inference' : value;
  const text = String(value ?? '').toLowerCase();
  if (/weak|speculat|possibly|perhaps|uncertain/.test(text)) return 'weak_inference';
  if (inference || /infer|impli|suggest/.test(text)) return 'strong_inference';
  return 'explicit';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeStructuralVariants(summary, { allowOmittedEmptyFamilies = false, allowProviderVocabularyVariants = false } = {}) {
  if (!summary.synopsis && typeof summary.synthesis === 'string') summary.synopsis = summary.synthesis;
  const emptyFields = allowOmittedEmptyFamilies ? SUMMARY_ARRAY_FIELDS : OMITTABLE_EMPTY_FIELDS;
  for (const field of emptyFields) {
    if (summary[field] === undefined || summary[field] === null) summary[field] = [];
  }
  const hoisted = Object.fromEntries(SUMMARY_ARRAY_FIELDS.map(field => [field, []]));
  let repairedNestedBatch = false;
  for (const field of SUMMARY_ARRAY_FIELDS) {
    if (!Array.isArray(summary[field])) continue;
    const values = summary[field];
    summary[field] = values.filter(item => {
      if (item?.[REQUIRED_ITEM_KEY[field]] !== undefined) return true;
      const nested = SUMMARY_ARRAY_FIELDS.filter(nestedField => Array.isArray(item?.[nestedField]));
      if (!nested.length) return true;
      repairedNestedBatch = true;
      for (const nestedField of nested) hoisted[nestedField].push(...item[nestedField]);
      return false;
    });
  }
  if (repairedNestedBatch) {
    for (const field of SUMMARY_ARRAY_FIELDS) {
      if (!Array.isArray(summary[field])) summary[field] = [];
      summary[field].push(...hoisted[field]);
    }
  }
  for (const item of [...(summary.events ?? []), ...(summary.observations ?? [])]) {
    if (!isRecord(item)) continue;
    if (item.salience === undefined && item.salence !== undefined) item.salience = item.salence;
    if (Object.hasOwn(item, 'salence')) delete item.salence;
  }
  for (const item of [...(summary.events ?? []), ...(summary.observations ?? [])]) {
    if (!isRecord(item)) continue;
    if (!Salience.has(item?.salience) && SALIENCE_ALIASES[item?.salience]) item.salience = SALIENCE_ALIASES[item.salience];
  }
  for (const observation of summary.observations ?? []) if (isRecord(observation)) {
    if (PERSISTENCE_ALIASES[observation.persistence]) observation.persistence = PERSISTENCE_ALIASES[observation.persistence];
    if (allowProviderVocabularyVariants && PROVIDER_PERSISTENCE_ALIASES[observation.persistence]) observation.persistence = PROVIDER_PERSISTENCE_ALIASES[observation.persistence];
  }
  for (const field of ['events', 'observations', 'stateChanges', 'knowledgeChanges', 'relationshipChanges', 'commitments', 'threads', 'salientNegatives', 'registerObservations', 'temporal', 'locations']) {
    for (const item of summary[field] ?? []) if (isRecord(item)) item.evidence = normalizeEvidence(item.evidence);
  }
  for (const item of summary.interpretations ?? []) if (isRecord(item)) item.evidence = normalizeEvidence(item.evidence, { inference: true });
  for (const change of summary.knowledgeChanges ?? []) {
    if (!isRecord(change)) continue;
    if (!EpistemicKind.has(change?.kind)) {
      const alias = KNOWLEDGE_KIND_ALIASES[change?.kind] ?? (allowProviderVocabularyVariants ? PROVIDER_KNOWLEDGE_KIND_ALIASES[change?.kind] : null);
      if (alias) change.kind = alias;
    }
    if (!['add', 'revise', 'remove'].includes(change?.operation) && KNOWLEDGE_OPERATION_ALIASES[change?.operation]) change.operation = KNOWLEDGE_OPERATION_ALIASES[change.operation];
    if (allowProviderVocabularyVariants && PROVIDER_KNOWLEDGE_OPERATION_ALIASES[change?.operation]) change.operation = PROVIDER_KNOWLEDGE_OPERATION_ALIASES[change.operation];
  }
  for (const change of summary.stateChanges ?? []) if (isRecord(change) && change.persistence === undefined) change.persistence = 'active';
  for (const change of summary.stateChanges ?? []) {
    if (!isRecord(change)) continue;
    if (change?.operation === 'update') change.operation = 'revise';
    if (change?.operation === 'maintain') change.operation = 'set';
    if (allowProviderVocabularyVariants && PROVIDER_STATE_OPERATION_ALIASES[change?.operation]) change.operation = PROVIDER_STATE_OPERATION_ALIASES[change.operation];
  }
  for (const change of summary.stateChanges ?? []) if (isRecord(change)) {
    if (PERSISTENCE_ALIASES[change.persistence]) change.persistence = PERSISTENCE_ALIASES[change.persistence];
    if (allowProviderVocabularyVariants && PROVIDER_PERSISTENCE_ALIASES[change.persistence]) change.persistence = PROVIDER_PERSISTENCE_ALIASES[change.persistence];
  }
  summary.relationshipChanges = (summary.relationshipChanges ?? []).filter(change => {
    if (!isRecord(change)) return true;
    if (allowProviderVocabularyVariants) {
      if (PROVIDER_RELATIONSHIP_DIMENSION_ALIASES[change?.dimension]) change.dimension = PROVIDER_RELATIONSHIP_DIMENSION_ALIASES[change.dimension];
      if (PROVIDER_CHANGE_OPERATION_ALIASES[change?.operation]) change.operation = PROVIDER_CHANGE_OPERATION_ALIASES[change.operation];
    }
    if (change?.operation === 'confirm') change.operation = 'set';
    return RelationshipDimension.has(change?.dimension) && ChangeOperation.has(change?.operation);
  });
  for (const commitment of summary.commitments ?? []) {
    if (!isRecord(commitment)) continue;
    if (!CommitmentStatus.has(commitment?.transition) && COMMITMENT_TRANSITION_ALIASES[commitment?.transition]) commitment.transition = COMMITMENT_TRANSITION_ALIASES[commitment.transition];
  }
  for (const item of [...(summary.events ?? []), ...(summary.observations ?? [])]) {
    if (!isRecord(item)) continue;
    if (!Array.isArray(item?.domains)) continue;
    item.domains = [...new Set(item.domains.map(value => {
      const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      return MemoryDomain.has(normalized) ? normalized : (DOMAIN_ALIASES[normalized] ?? 'other');
    }))];
  }
  for (const thread of summary.threads ?? []) {
    if (THREAD_TRANSITION_ALIASES[thread?.transition]) thread.transition = THREAD_TRANSITION_ALIASES[thread.transition];
  }
  summary.threads = (summary.threads ?? []).filter(thread => thread?.transition !== 'unchanged');
  for (const temporal of summary.temporal ?? []) {
    if (TEMPORAL_KIND_ALIASES[temporal?.kind]) temporal.kind = TEMPORAL_KIND_ALIASES[temporal.kind];
    if (allowProviderVocabularyVariants && PROVIDER_TEMPORAL_KIND_ALIASES[temporal?.kind]) temporal.kind = PROVIDER_TEMPORAL_KIND_ALIASES[temporal.kind];
  }
  summary.temporal = (summary.temporal ?? []).filter(item => TemporalEvidenceKind.has(item?.kind));
  for (const location of summary.locations ?? []) {
    if (LOCATION_KIND_ALIASES[location?.kind]) location.kind = LOCATION_KIND_ALIASES[location.kind];
    if (allowProviderVocabularyVariants && PROVIDER_LOCATION_KIND_ALIASES[location?.kind]) location.kind = PROVIDER_LOCATION_KIND_ALIASES[location.kind];
  }
  summary.locations = (summary.locations ?? []).filter(item => LocationEvidenceKind.has(item?.kind));
  for (const [index, observation] of (summary.registerObservations ?? []).entries()) {
    if (!isRecord(observation)) continue;
    if (observation.kind === 'generic') {
      observation.observationKey = observation.observationKey || observation.eventKey || `update_${index + 1}`;
      continue;
    }
    const validSpecialization = observation.kind === 'amendment'
      ? Boolean(observation.eventKey && observation.subject && Object.hasOwn(observation, 'newValue'))
      : observation.kind === 'event_result'
        ? Boolean(observation.eventKey && Array.isArray(observation.entries) && observation.entries.length)
        : observation.kind === 'snapshot'
          ? Boolean(Array.isArray(observation.values) && ['partial', 'complete'].includes(observation.completeness))
          : false;
    if (validSpecialization) continue;
    const originalKind = observation.kind;
    observation.kind = 'generic';
    observation.observationKey = observation.observationKey || observation.eventKey || `${originalKind || 'update'}_${index + 1}`;
    if (!Object.hasOwn(observation, 'value') && Object.hasOwn(observation, 'newValue')) observation.value = observation.newValue;
    if (!Object.hasOwn(observation, 'value') && Array.isArray(observation.values)) observation.value = observation.values;
    if (!Object.hasOwn(observation, 'value') && Array.isArray(observation.entries)) observation.value = observation.entries;
  }
}

export function normalizeExtractedSummary(input, { contextKey = '', knownEntities = [], entityRegistry = null, allowOmittedEmptyFamilies = false, allowProviderVocabularyVariants = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const summary = structuredClone(input);
  normalizeStructuralVariants(summary, { allowOmittedEmptyFamilies, allowProviderVocabularyVariants });
  if (!Array.isArray(summary.entities)) return summary;
  // Hydrate from the durable materialized view unless the caller supplies a
  // shared registry.  Existing IDs remain authoritative; this is the key
  // compatibility rule for old rebuilds and imported sessions.
  const registry = entityRegistry ?? EntityRegistry.fromRecords(knownEntities, { contextKey });

  const idForMention = (mention, proposedId = null) => {
    const normalized = normalizeAlias(mention);
    if (!normalized) return null;
    if (ENTITY_ID_PATTERN.test(proposedId ?? '')) return proposedId;
    const proposal = registry.propose(mention, { contextKey });
    // Fuzzy/ambiguous proposals remain unresolved.  Silently accepting one
    // would turn a partial name into a durable merge, which is exactly the
    // false-positive the registry is intended to prevent.
    return proposal.proposedEntityId && !proposal.requiresConfirmation
      ? proposal.proposedEntityId
      : entityIdFromSeed(`chat:${contextKey || 'unknown'}:mention:${normalized}`);
  };
  const ensureMention = (mention, proposedId = null, extraAliases = []) => {
    const id = idForMention(mention, proposedId);
    if (!id) return null;
    registry.observeMention({ entityId: id, mention, aliases: extraAliases, contextKey });
    if (!summary.entities.some(entity => entity.proposedEntityId === id)) {
      summary.entities.push({ mention: String(mention), proposedEntityId: id, ...(extraAliases.length ? { aliases: [...new Set(extraAliases.map(String))] } : {}) });
    }
    return id;
  };

  for (const entity of [...summary.entities]) {
    if (!entity?.mention) continue;
    const extraAliases = Array.isArray(entity.aliases) ? entity.aliases : [];
    entity.proposedEntityId = idForMention(entity.mention, entity.proposedEntityId);
    if (entity.proposedEntityId) registry.observeMention({ entityId: entity.proposedEntityId, mention: entity.mention, aliases: extraAliases, contextKey });
  }

  const resolve = (value, { create = true } = {}) => {
    if (ENTITY_ID_PATTERN.test(value ?? '')) return value;
    const normalized = normalizeAlias(value);
    if (!normalized) return value;
    const proposal = registry.propose(value, { contextKey });
    const existing = proposal.proposedEntityId && !proposal.requiresConfirmation ? proposal.proposedEntityId : null;
    return existing ?? (create ? ensureMention(value) : value);
  };

  for (const event of summary.events ?? []) if (Array.isArray(event.participants)) event.participants = event.participants.map(value => resolve(value));
  for (const change of summary.stateChanges ?? []) if (change.subject) change.subject = resolve(change.subject);
  for (const change of summary.knowledgeChanges ?? []) if (change.holder) change.holder = resolve(change.holder);
  for (const change of summary.relationshipChanges ?? []) if (Array.isArray(change.participants)) change.participants = change.participants.map(value => resolve(value));
  for (const commitment of summary.commitments ?? []) {
    if (commitment.actor) commitment.actor = resolve(commitment.actor);
    if (commitment.toward) commitment.toward = resolve(commitment.toward);
  }
  for (const observation of summary.observations ?? []) if (observation.subject) observation.subject = resolve(observation.subject, { create: false });
  for (const location of summary.locations ?? []) if (location.subject) location.subject = resolve(location.subject, { create: false });
  return summary;
}

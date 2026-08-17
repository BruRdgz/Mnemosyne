import { SCHEMA_VERSION } from '../core/constants.js';
import {
  ChangeOperation, CommitmentStatus, ConflictStatus, EpistemicKind, EvidenceLevel,
  LocationEvidenceKind, MemoryDomain, MemorySegmentStatus, ModelEvidenceLevel,
  ModelPersistenceClass, PersistenceClass, RegisterLifecycle, RegisterObservationKind,
  RelationshipDimension, Salience, TemporalEvidenceKind, ThreadStatus,
} from './enums.js';
import { assertEntityId, assertSegmentId } from './ids.js';

export class SchemaValidationError extends TypeError {
  constructor(errors) {
    super(`Schema validation failed: ${errors.join('; ')}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

function validateEnum(errors, path, value, set) {
  if (!set.has(value)) errors.push(`${path} received ${JSON.stringify(value)}; must be one of ${set.values.join(', ')}`);
}

function validateStringArray(errors, path, value, { nonEmptyItems = true } = {}) {
  if (!Array.isArray(value)) return errors.push(`${path} must be an array`);
  value.forEach((item, index) => {
    if (typeof item !== 'string' || (nonEmptyItems && !item.trim())) errors.push(`${path}[${index}] must be a non-empty string`);
  });
}

function validateCommonEvidence(errors, path, item, { model = true } = {}) {
  validateEnum(errors, `${path}.evidence`, item.evidence, model ? ModelEvidenceLevel : EvidenceLevel);
}

function validateEntity(errors, item, index) {
  const path = `entities[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!nonEmpty(item.mention)) errors.push(`${path}.mention is required`);
  if (item.proposedEntityId !== undefined) {
    try { assertEntityId(item.proposedEntityId); } catch { errors.push(`${path}.proposedEntityId is invalid`); }
  }
  if (item.aliases !== undefined) validateStringArray(errors, `${path}.aliases`, item.aliases);
}

function validateEvent(errors, item, index) {
  const path = `events[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!nonEmpty(item.description)) errors.push(`${path}.description is required`);
  validateStringArray(errors, `${path}.participants`, item.participants);
  validateCommonEvidence(errors, path, item);
  validateEnum(errors, `${path}.salience`, item.salience, Salience);
  if (!Array.isArray(item.domains)) errors.push(`${path}.domains must be an array`);
  else item.domains.forEach((domain, i) => validateEnum(errors, `${path}.domains[${i}]`, domain, MemoryDomain));
}

function validateObservation(errors, item, index) {
  const path = `observations[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!nonEmpty(item.description)) errors.push(`${path}.description is required`);
  if (!Object.hasOwn(item, 'value')) errors.push(`${path}.value is required`);
  validateCommonEvidence(errors, path, item);
  validateEnum(errors, `${path}.persistence`, item.persistence, ModelPersistenceClass);
  validateEnum(errors, `${path}.salience`, item.salience, Salience);
  if (!Array.isArray(item.domains)) errors.push(`${path}.domains must be an array`);
  else item.domains.forEach((domain, i) => validateEnum(errors, `${path}.domains[${i}]`, domain, MemoryDomain));
  if (item.continuityRelevant !== undefined && typeof item.continuityRelevant !== 'boolean') errors.push(`${path}.continuityRelevant must be boolean`);
}

function validateStateChange(errors, item, index) {
  const path = `stateChanges[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!nonEmpty(item.subject)) errors.push(`${path}.subject is required`);
  if (!nonEmpty(item.path)) errors.push(`${path}.path is required`);
  validateEnum(errors, `${path}.operation`, item.operation, ChangeOperation);
  validateCommonEvidence(errors, path, item);
  validateEnum(errors, `${path}.persistence`, item.persistence, ModelPersistenceClass);
}

function validateKnowledgeChange(errors, item, index) {
  const path = `knowledgeChanges[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  try { assertEntityId(item.holder); } catch { errors.push(`${path}.holder must be an EntityId`); }
  if (!nonEmpty(item.proposition)) errors.push(`${path}.proposition is required`);
  validateEnum(errors, `${path}.kind`, item.kind, EpistemicKind);
  if (!['add', 'revise', 'remove'].includes(item.operation)) errors.push(`${path}.operation must be add, revise, or remove`);
  validateCommonEvidence(errors, path, item);
}

function validateRelationshipChange(errors, item, index) {
  const path = `relationshipChanges[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!Array.isArray(item.participants) || item.participants.length < 2) errors.push(`${path}.participants requires at least two EntityIds`);
  else item.participants.forEach((id, i) => { try { assertEntityId(id); } catch { errors.push(`${path}.participants[${i}] is invalid`); } });
  validateEnum(errors, `${path}.dimension`, item.dimension, RelationshipDimension);
  validateEnum(errors, `${path}.operation`, item.operation, ChangeOperation);
  if (!Object.hasOwn(item, 'value')) errors.push(`${path}.value is required`);
  validateCommonEvidence(errors, path, item);
}

function validateCommitment(errors, item, index) {
  const path = `commitments[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  try { assertEntityId(item.actor); } catch { errors.push(`${path}.actor must be an EntityId`); }
  if (item.toward !== undefined) try { assertEntityId(item.toward); } catch { errors.push(`${path}.toward must be an EntityId`); }
  if (!nonEmpty(item.content)) errors.push(`${path}.content is required`);
  validateEnum(errors, `${path}.transition`, item.transition, CommitmentStatus);
  validateCommonEvidence(errors, path, item);
}

function validateThread(errors, item, index) {
  const path = `threads[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!nonEmpty(item.key)) errors.push(`${path}.key is required`);
  if (!nonEmpty(item.description)) errors.push(`${path}.description is required`);
  validateEnum(errors, `${path}.transition`, item.transition, ThreadStatus);
  validateCommonEvidence(errors, path, item);
}

function validateNegative(errors, item, index) {
  const path = `salientNegatives[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  if (!nonEmpty(item.proposition)) errors.push(`${path}.proposition is required`);
  if (!nonEmpty(item.reason)) errors.push(`${path}.reason is required`);
  if (!['explicit', 'strong_inference'].includes(item.evidence)) errors.push(`${path}.evidence cannot be weak inference`);
  if (item.continuityRelevant !== undefined && typeof item.continuityRelevant !== 'boolean') errors.push(`${path}.continuityRelevant must be boolean`);
}

function validateRegister(errors, item, index) {
  const path = `registerObservations[${index}]`;
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  validateEnum(errors, `${path}.kind`, item.kind, RegisterObservationKind);
  if (!nonEmpty(item.registerKey)) errors.push(`${path}.registerKey is required`);
  validateCommonEvidence(errors, path, item);
  if (item.kind === 'event_result') {
    if (!nonEmpty(item.eventKey)) errors.push(`${path}.eventKey is required`);
    if (!Array.isArray(item.entries) || item.entries.length === 0) errors.push(`${path}.entries must be non-empty`);
  } else if (item.kind === 'amendment') {
    if (!nonEmpty(item.eventKey) || !nonEmpty(item.subject)) errors.push(`${path} amendment requires eventKey and subject`);
    if (!Object.hasOwn(item, 'newValue')) errors.push(`${path}.newValue is required`);
  } else if (item.kind === 'snapshot') {
    if (!Array.isArray(item.values)) errors.push(`${path}.values must be an array`);
    if (!['partial', 'complete'].includes(item.completeness)) errors.push(`${path}.completeness must be partial or complete`);
  } else if (!nonEmpty(item.observationKey)) errors.push(`${path}.observationKey is required for generic observations`);
}

function validateInterpretation(errors, item, index) {
  const path = `interpretations[${index}]`;
  if (!isObject(item) || !nonEmpty(item.description)) return errors.push(`${path}.description is required`);
  if (!['strong_inference', 'weak_inference'].includes(item.evidence)) errors.push(`${path}.evidence must be an inference level`);
}

function validateTemporal(errors, item, index) {
  const path = `temporal[${index}]`;
  if (!isObject(item) || !nonEmpty(item.description)) return errors.push(`${path}.description is required`);
  validateEnum(errors, `${path}.kind`, item.kind, TemporalEvidenceKind);
  validateCommonEvidence(errors, path, item);
}

function validateLocation(errors, item, index) {
  const path = `locations[${index}]`;
  if (!isObject(item) || !nonEmpty(item.location)) return errors.push(`${path}.location is required`);
  validateEnum(errors, `${path}.kind`, item.kind, LocationEvidenceKind);
  validateCommonEvidence(errors, path, item);
}

const ARRAY_VALIDATORS = Object.freeze({
  entities: validateEntity,
  events: validateEvent,
  observations: validateObservation,
  stateChanges: validateStateChange,
  knowledgeChanges: validateKnowledgeChange,
  relationshipChanges: validateRelationshipChange,
  commitments: validateCommitment,
  threads: validateThread,
  salientNegatives: validateNegative,
  registerObservations: validateRegister,
  interpretations: validateInterpretation,
  temporal: validateTemporal,
  locations: validateLocation,
});

export function validateEpisodeSummary(input, { throwOnError = false } = {}) {
  const errors = [];
  if (!isObject(input)) errors.push('episode must be an object');
  else {
    if (!nonEmpty(input.synopsis)) errors.push('synopsis is required');
    for (const [field, validator] of Object.entries(ARRAY_VALIDATORS)) {
      if (!Array.isArray(input[field])) errors.push(`${field} must be an array`);
      else input[field].forEach((item, index) => validator(errors, item, index));
    }
    if (input.salience !== undefined) validateEnum(errors, 'salience', input.salience, Salience);
  }
  if (errors.length && throwOnError) throw new SchemaValidationError(errors);
  return { ok: errors.length === 0, errors, value: errors.length ? null : compactSparse(structuredClone(input)) };
}

export function validateMemorySegment(input, { throwOnError = false } = {}) {
  const errors = [];
  if (!isObject(input)) errors.push('segment must be an object');
  else {
    try { assertSegmentId(input.id); } catch { errors.push('id must be a SegmentId'); }
    if (!isObject(input.source) || !isObject(input.source.first) || !isObject(input.source.last) || !nonEmpty(input.source.rangeFingerprint)) errors.push('source range is invalid');
    validateStringArray(errors, 'dependencyIds', input.dependencyIds);
    if (!Number.isInteger(input.sourceTokenCount) || input.sourceTokenCount < 0) errors.push('sourceTokenCount must be a non-negative integer');
    validateEnum(errors, 'status', input.status, MemorySegmentStatus);
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) errors.push('schemaVersion is required');
    if (!Number.isInteger(input.promptVersion) || input.promptVersion < 1) errors.push('promptVersion is required');
    if (input.status === 'valid') {
      const result = validateEpisodeSummary(input.summary);
      errors.push(...result.errors.map(error => `summary.${error}`));
    } else if (input.summary !== null && input.summary !== undefined) {
      const result = validateEpisodeSummary(input.summary);
      errors.push(...result.errors.map(error => `summary.${error}`));
    }
    for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(input[field])) errors.push(`${field} is required`);
    for (const field of ['manuallyEdited', 'pinned']) if (typeof input[field] !== 'boolean') errors.push(`${field} must be boolean`);
  }
  if (errors.length && throwOnError) throw new SchemaValidationError(errors);
  return { ok: errors.length === 0, errors, value: errors.length ? null : compactSparse(structuredClone(input)) };
}

export function validateConflict(input, { throwOnError = false } = {}) {
  const errors = [];
  if (!isObject(input)) errors.push('conflict must be an object');
  else {
    if (!nonEmpty(input.id) || !nonEmpty(input.property)) errors.push('conflict id and property are required');
    if (!Array.isArray(input.candidates) || input.candidates.length < 2) errors.push('conflict requires at least two candidates');
    else input.candidates.forEach((candidate, index) => {
      if (!isObject(candidate) || !nonEmpty(candidate.sourceFingerprint) || !nonEmpty(candidate.description)) errors.push(`candidates[${index}] is invalid`);
    });
    validateEnum(errors, 'status', input.status, ConflictStatus);
  }
  if (errors.length && throwOnError) throw new SchemaValidationError(errors);
  return { ok: errors.length === 0, errors, value: errors.length ? null : compactSparse(structuredClone(input)) };
}

export function validateRegisterEnvelope(input, { throwOnError = false } = {}) {
  const errors = [];
  if (!isObject(input)) errors.push('register must be an object');
  else {
    if (!nonEmpty(input.key) || !nonEmpty(input.type)) errors.push('register key and type are required');
    validateEnum(errors, 'lifecycle', input.lifecycle, RegisterLifecycle);
    if (!Array.isArray(input.observations)) errors.push('register observations must be an array');
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) errors.push('register schemaVersion is required');
  }
  if (errors.length && throwOnError) throw new SchemaValidationError(errors);
  return { ok: errors.length === 0, errors, value: errors.length ? null : compactSparse(structuredClone(input)) };
}

export function compactSparse(value) {
  if (Array.isArray(value)) return value.map(compactSparse);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .map(([key, nested]) => [key, compactSparse(nested)]));
}

export function serializePortable(value) {
  return JSON.stringify(compactSparse(value));
}

export function deserializePortable(json, validator) {
  const parsed = JSON.parse(json);
  const result = validator(parsed, { throwOnError: true });
  return result.value;
}

const stringRef = { type: 'string', minLength: 1 };
const stringArray = { type: 'array', items: stringRef };
const modelEvidence = { enum: ModelEvidenceLevel.values };
const inferenceEvidence = { enum: ['strong_inference', 'weak_inference'] };
const episodeItem = (properties, required, { additionalProperties = false } = {}) => ({
  type: 'object', additionalProperties, properties, required,
});
const episodeArray = schema => ({ type: 'array', items: schema });

export const EPISODE_EXTRACTION_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'MnemosyneEpisodeExtraction',
  type: 'object',
  additionalProperties: false,
  required: ['synopsis', ...Object.keys(ARRAY_VALIDATORS)],
  properties: {
    synopsis: { type: 'string', minLength: 1, description: 'Two to five complete sentences covering only target events.' },
    entities: episodeArray(episodeItem({ mention: stringRef, proposedEntityId: stringRef, aliases: stringArray }, ['mention'])),
    events: episodeArray(episodeItem({ description: stringRef, participants: stringArray, evidence: modelEvidence, salience: { enum: Salience.values }, domains: episodeArray({ enum: MemoryDomain.values }) }, ['description', 'participants', 'evidence', 'salience', 'domains'])),
    observations: episodeArray(episodeItem({ subject: stringRef, predicate: stringRef, value: {}, description: stringRef, evidence: modelEvidence, epistemicScope: { enum: ['world', 'narrator'] }, persistence: { enum: ModelPersistenceClass.values }, salience: { enum: Salience.values }, domains: episodeArray({ enum: MemoryDomain.values }), continuityRelevant: { type: 'boolean' } }, ['description', 'value', 'evidence', 'persistence', 'salience', 'domains'])),
    stateChanges: episodeArray(episodeItem({ subject: stringRef, path: stringRef, operation: { enum: ChangeOperation.values }, value: {}, evidence: modelEvidence, persistence: { enum: ModelPersistenceClass.values } }, ['subject', 'path', 'operation', 'value', 'evidence', 'persistence'])),
    knowledgeChanges: episodeArray(episodeItem({ holder: stringRef, proposition: stringRef, kind: { enum: EpistemicKind.values }, operation: { enum: ['add', 'revise', 'remove'] }, evidence: modelEvidence }, ['holder', 'proposition', 'kind', 'operation', 'evidence'])),
    relationshipChanges: episodeArray(episodeItem({ participants: { type: 'array', minItems: 2, items: stringRef }, dimension: { enum: RelationshipDimension.values }, operation: { enum: ChangeOperation.values }, value: {}, evidence: modelEvidence }, ['participants', 'dimension', 'operation', 'value', 'evidence'])),
    commitments: episodeArray(episodeItem({ id: stringRef, actor: stringRef, toward: stringRef, content: stringRef, transition: { enum: CommitmentStatus.values }, evidence: modelEvidence }, ['actor', 'content', 'transition', 'evidence'])),
    threads: episodeArray(episodeItem({ key: stringRef, description: stringRef, transition: { enum: ThreadStatus.values }, evidence: modelEvidence }, ['key', 'description', 'transition', 'evidence'])),
    salientNegatives: episodeArray(episodeItem({ proposition: stringRef, reason: stringRef, evidence: { enum: ['explicit', 'strong_inference'] }, continuityRelevant: { type: 'boolean' } }, ['proposition', 'reason', 'evidence'])),
    registerObservations: episodeArray(episodeItem({ kind: { enum: RegisterObservationKind.values }, registerKey: stringRef, evidence: modelEvidence, eventKey: stringRef, entries: { type: 'array', items: { type: 'object' } }, subject: stringRef, newValue: {}, values: { type: 'array', items: { type: 'object' } }, completeness: { enum: ['partial', 'complete'] }, observationKey: stringRef }, ['kind', 'registerKey', 'evidence'], { additionalProperties: true })),
    interpretations: episodeArray(episodeItem({ description: stringRef, evidence: inferenceEvidence }, ['description', 'evidence'])),
    temporal: episodeArray(episodeItem({ description: stringRef, kind: { enum: TemporalEvidenceKind.values }, evidence: modelEvidence }, ['description', 'kind', 'evidence'])),
    locations: episodeArray(episodeItem({ subject: stringRef, location: stringRef, kind: { enum: LocationEvidenceKind.values }, evidence: modelEvidence }, ['location', 'kind', 'evidence'])),
    salience: { enum: Salience.values },
  },
  'x-mnemosyne-schema-version': SCHEMA_VERSION,
});

export function emptyEpisodeSummary(synopsis) {
  return {
    synopsis,
    ...Object.fromEntries(Object.keys(ARRAY_VALIDATORS).map(field => [field, []])),
    salience: 'normal',
  };
}

export { SCHEMA_VERSION };

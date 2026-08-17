import {
  ChangeOperation, CommitmentStatus, EpistemicKind, LocationEvidenceKind, MemoryDomain,
  ModelEvidenceLevel, ModelPersistenceClass, RegisterObservationKind, RelationshipDimension,
  Salience, TemporalEvidenceKind, ThreadStatus,
} from '../domain/enums.js';
import { emptyEpisodeSummary, validateEpisodeSummary } from '../domain/schema.js';
import { normalizeExtractedSummary } from './semantic-normalizer.js';

const KNOWN_SECTIONS = new Set([
  'SYNOPSIS', 'ENTITIES', 'EVENTS', 'OBSERVATIONS', 'STATE_CHANGES', 'KNOWLEDGE',
  'RELATIONSHIPS', 'COMMITMENTS', 'THREADS', 'SALIENT_NEGATIVES', 'REGISTERS',
  'INTERPRETATIONS', 'TEMPORAL', 'LOCATIONS',
]);
const MAX_ITEMS_PER_SECTION = 100;
const MAX_FIELD_LENGTH = 2_000;
const EMPTY_MARKERS = new Set(['none', '(none)', 'empty', 'n/a', 'not applicable']);

export function sanitizeFallbackText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}

function splitSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const tag = line.trim().match(/^\[([A-Z_]+)]$/)?.[1];
    if (tag) {
      current = KNOWN_SECTIONS.has(tag) ? tag : null;
      if (current && !sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  return sections;
}

function parseFields(line) {
  const fields = {};
  for (const part of line.replace(/^\s*-\s*/, '').split('|')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = sanitizeFallbackText(part.slice(separator + 1));
    if (key && value) fields[key] = value;
  }
  return fields;
}

function plainLine(line) {
  return sanitizeFallbackText(line.replace(/^\s*-\s*/, '').split('|')[0]);
}

function lines(sections, name, warnings) {
  const values = (sections.get(name) ?? []).map(line => line.trim()).filter(line => line.startsWith('-'))
    .filter(line => !EMPTY_MARKERS.has(plainLine(line).toLowerCase()));
  if (values.length > MAX_ITEMS_PER_SECTION) warnings.push(`${name}: item cap applied`);
  return values.slice(0, MAX_ITEMS_PER_SECTION);
}

function list(value) {
  return String(value ?? '').split(',').map(item => sanitizeFallbackText(item)).filter(Boolean);
}

function scalar(value) {
  const text = sanitizeFallbackText(value);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  try { return JSON.parse(text); } catch { return text; }
}

function boolean(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  return fallback;
}

export function parseFallbackExtraction(text, { contextKey = '', knownEntities = [], requireSemantic = false } = {}) {
  const warnings = [];
  const sections = splitSections(text);
  const synopsis = sanitizeFallbackText((sections.get('SYNOPSIS') ?? []).join('\n'));
  if (!synopsis) return { ok: false, fatal: true, reason: 'missing_synopsis', warnings: ['Missing [SYNOPSIS]'], summary: null, degraded: true };
  if (!/[.!?]["'’”\])}]*$/u.test(synopsis)) {
    return { ok: false, fatal: true, reason: 'truncated_synopsis', warnings: ['Fallback synopsis does not end with a complete sentence'], summary: null, degraded: true };
  }
  const summary = emptyEpisodeSummary(synopsis);

  for (const line of lines(sections, 'ENTITIES', warnings)) {
    const f = parseFields(line);
    const mention = f.mention ?? f.name ?? plainLine(line);
    if (!mention) { warnings.push('ENTITIES: discarded invalid line'); continue; }
    summary.entities.push({ mention, ...(f.aliases ? { aliases: list(f.aliases) } : {}) });
  }

  for (const line of lines(sections, 'EVENTS', warnings)) {
    const f = parseFields(line);
    const description = f.description ?? f.event ?? plainLine(line);
    const evidence = f.evidence ?? 'explicit';
    const salience = f.salience ?? 'normal';
    const domains = f.domains ? list(f.domains) : ['general'];
    if (!description || !ModelEvidenceLevel.has(evidence) || !Salience.has(salience) || !domains.every(domain => MemoryDomain.has(domain))) {
      warnings.push('EVENTS: discarded invalid line'); continue;
    }
    summary.events.push({ description, participants: list(f.participants), evidence, salience, domains });
  }

  for (const line of lines(sections, 'OBSERVATIONS', warnings)) {
    const f = parseFields(line);
    const description = f.fact ?? f.description;
    const evidence = f.evidence ?? 'explicit';
    const persistence = f.persistence ?? 'historical';
    const salience = f.salience ?? 'normal';
    const domains = f.domains ? list(f.domains) : ['general'];
    if (!description || !ModelEvidenceLevel.has(evidence) || !ModelPersistenceClass.has(persistence) || !Salience.has(salience) || !domains.every(domain => MemoryDomain.has(domain))) {
      warnings.push('OBSERVATIONS: discarded invalid line'); continue;
    }
    summary.observations.push({
      ...(f.subject ? { subject: f.subject } : {}), ...(f.predicate ? { predicate: f.predicate } : {}),
      ...(f.scope && ['world', 'narrator'].includes(f.scope) ? { epistemicScope: f.scope } : {}),
      value: f.value !== undefined ? scalar(f.value) : description, description, evidence, persistence, salience, domains,
      ...(boolean(f.continuity) !== undefined ? { continuityRelevant: boolean(f.continuity) } : {}),
    });
  }

  for (const line of lines(sections, 'STATE_CHANGES', warnings)) {
    const f = parseFields(line);
    const operation = f.operation ?? 'set';
    const evidence = f.evidence ?? 'explicit';
    const persistence = f.persistence ?? 'active';
    if (!f.subject || !f.path || f.value === undefined || !ChangeOperation.has(operation) || !ModelEvidenceLevel.has(evidence) || !ModelPersistenceClass.has(persistence)) {
      warnings.push('STATE_CHANGES: discarded invalid line'); continue;
    }
    summary.stateChanges.push({ subject: f.subject, path: f.path, operation, value: scalar(f.value), evidence, persistence });
  }

  for (const line of lines(sections, 'KNOWLEDGE', warnings)) {
    const f = parseFields(line);
    const operation = f.operation ?? 'add';
    const evidence = f.evidence ?? 'explicit';
    if (!f.holder || !EpistemicKind.has(f.kind) || !f.proposition || !['add', 'revise', 'remove'].includes(operation) || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('KNOWLEDGE: discarded invalid line'); continue;
    }
    summary.knowledgeChanges.push({ holder: f.holder, kind: f.kind, proposition: f.proposition, operation, evidence });
  }

  for (const line of lines(sections, 'RELATIONSHIPS', warnings)) {
    const f = parseFields(line);
    const participants = list(f.participants);
    const operation = f.operation ?? 'set';
    const value = f.value ?? f.change;
    const evidence = f.evidence ?? 'explicit';
    if (participants.length < 2 || !RelationshipDimension.has(f.dimension) || !ChangeOperation.has(operation) || value === undefined || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('RELATIONSHIPS: discarded invalid line'); continue;
    }
    summary.relationshipChanges.push({ participants, dimension: f.dimension, operation, value: scalar(value), evidence });
  }

  for (const line of lines(sections, 'COMMITMENTS', warnings)) {
    const f = parseFields(line);
    const evidence = f.evidence ?? 'explicit';
    if (!f.actor || !CommitmentStatus.has(f.transition) || !f.content || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('COMMITMENTS: discarded invalid line'); continue;
    }
    summary.commitments.push({ ...(f.id ? { id: f.id } : {}), actor: f.actor, ...(f.toward ? { toward: f.toward } : {}), transition: f.transition, content: f.content, evidence });
  }

  for (const line of lines(sections, 'THREADS', warnings)) {
    const f = parseFields(line);
    const transition = f.transition === 'advance' ? 'advanced' : f.transition;
    const evidence = f.evidence ?? 'explicit';
    if (!f.key || !ThreadStatus.has(transition) || !f.description || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('THREADS: discarded invalid line'); continue;
    }
    summary.threads.push({ key: f.key, transition, description: f.description, evidence });
  }

  for (const line of lines(sections, 'SALIENT_NEGATIVES', warnings)) {
    const f = parseFields(line);
    const continuityRelevant = boolean(f.continuity, false);
    if (!f.proposition || !f.reason || !continuityRelevant) {
      warnings.push('SALIENT_NEGATIVES: discarded non-continuity line'); continue;
    }
    summary.salientNegatives.push({ proposition: f.proposition, reason: f.reason, evidence: 'explicit', continuityRelevant: true });
  }

  for (const line of lines(sections, 'REGISTERS', warnings)) {
    const f = parseFields(line);
    const kind = f.kind ?? 'generic';
    const evidence = f.evidence ?? 'explicit';
    if (!RegisterObservationKind.has(kind) || !f.registerkey || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('REGISTERS: discarded invalid line'); continue;
    }
    const observation = { kind, registerKey: f.registerkey, evidence };
    if (kind === 'generic') observation.observationKey = f.observationkey ?? f.key ?? sanitizeFallbackText(f.value ?? 'update').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (f.value !== undefined) observation.value = scalar(f.value);
    summary.registerObservations.push(observation);
  }

  for (const line of lines(sections, 'INTERPRETATIONS', warnings)) {
    const f = parseFields(line);
    const description = f.description ?? plainLine(line);
    if (!description || !['strong_inference', 'weak_inference'].includes(f.evidence)) {
      warnings.push('INTERPRETATIONS: discarded invalid line'); continue;
    }
    summary.interpretations.push({ description, evidence: f.evidence });
  }

  for (const line of lines(sections, 'TEMPORAL', warnings)) {
    const f = parseFields(line);
    const description = f.description ?? plainLine(line);
    const evidence = f.evidence ?? 'explicit';
    if (!description || !TemporalEvidenceKind.has(f.kind) || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('TEMPORAL: discarded invalid line'); continue;
    }
    summary.temporal.push({ description, kind: f.kind, evidence });
  }

  for (const line of lines(sections, 'LOCATIONS', warnings)) {
    const f = parseFields(line);
    const evidence = f.evidence ?? 'explicit';
    if (!f.location || !LocationEvidenceKind.has(f.kind) || !ModelEvidenceLevel.has(evidence)) {
      warnings.push('LOCATIONS: discarded invalid line'); continue;
    }
    summary.locations.push({ ...(f.subject ? { subject: f.subject } : {}), location: f.location, kind: f.kind, evidence });
  }

  const normalized = normalizeExtractedSummary(summary, { contextKey, knownEntities });
  const validated = validateEpisodeSummary(normalized);
  if (!validated.ok) {
    return {
      ok: false,
      fatal: true,
      reason: 'fallback_schema_invalid',
      errors: validated.errors,
      diagnostics: { kind: 'fallback_schema_validation', source: 'local_validator', errors: validated.errors },
      warnings: [...warnings, ...validated.errors],
      summary: null,
      degraded: true,
    };
  }
  const structuredCount = Object.entries(validated.value).filter(([, value]) => Array.isArray(value)).reduce((sum, [, value]) => sum + value.length, 0);
  const semanticFamilies = [
    'events', 'observations', 'stateChanges', 'knowledgeChanges', 'relationshipChanges',
    'commitments', 'threads', 'salientNegatives', 'registerObservations', 'interpretations',
    'temporal', 'locations',
  ];
  const semanticCount = semanticFamilies.reduce((sum, family) => sum + (validated.value[family]?.length ?? 0), 0);
  if (requireSemantic && semanticCount === 0) {
    const error = 'Fallback must contain at least one validated semantic record in addition to the synopsis';
    return {
      ok: false,
      fatal: true,
      reason: 'fallback_semantic_empty',
      errors: [error],
      diagnostics: { kind: 'fallback_semantic_validation', source: 'local_validator', errors: [error] },
      warnings: [...warnings, error],
      summary: null,
      degraded: true,
    };
  }
  return { ok: true, fatal: false, warnings, summary: validated.value, degraded: structuredCount === 0, structuredCount };
}

export { MAX_FIELD_LENGTH, MAX_ITEMS_PER_SECTION };

import { normalizeAlias } from '../entities/entity-registry.js';

function tokens(value) {
  return normalizeAlias(String(value ?? '')).split(' ').filter(token => token.length > 1);
}

function scalar(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join(', ');
  return Object.entries(value).map(([key, item]) => `${key}=${scalar(item)}`).join(' ');
}

function renderObservation(observation) {
  const event = observation.eventKey ? ` ${observation.eventKey}` : '';
  const rows = observation.entries ?? observation.values;
  const payload = rows?.length ? rows.map(scalar).join('; ') : scalar(observation.newValue ?? observation.value);
  const subject = observation.subject ? ` ${observation.subject}` : '';
  return `${observation.kind ?? 'observation'}${event}${subject}${payload ? `: ${payload}` : ''}`;
}

export function directlyRelevantRegisterKeys(registers, queryText) {
  const query = new Set(tokens(queryText));
  return (registers ?? []).filter(register => {
    const identity = [...tokens(register.key), ...tokens(register.type)];
    return identity.some(token => query.has(token));
  }).map(register => register.key);
}

export function projectRegisters(registers, { relevantKeys = [], manualKeys = [], observationLimit = 5 } = {}) {
  const relevant = new Set(relevantKeys);
  const manual = new Set(manualKeys);
  return (registers ?? []).filter(register => {
    const lifecycle = register.lifecycle ?? register.status ?? 'active';
    const policy = register.injectionPolicy ?? 'relevant';
    if (lifecycle === 'archived') return policy === 'archived' && (manual.has(register.key) || relevant.has(register.key));
    if (policy === 'always') return true;
    if (policy === 'manual') return manual.has(register.key);
    if (policy === 'archived') return false;
    return relevant.has(register.key);
  }).map(register => {
    const observations = (register.observations ?? register.projection?.observations ?? []).slice(-Math.max(1, observationLimit));
    const details = observations.map(renderObservation).filter(Boolean).join(' | ');
    return {
      id: `register:${register.key}`,
      key: register.key,
      priority: register.injectionPolicy === 'always' ? 100 : 80,
      text: `Register ${register.key} (${register.type}, ${register.lifecycle ?? 'active'}): ${details || scalar(register.projection) || 'no current observations'}`,
    };
  });
}

import { normalizeAlias } from '../entities/entity-registry.js';

function uniqueNames(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const name = String(value ?? '').trim();
    const key = normalizeAlias(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export function collectGroupParticipants(messages = []) {
  return uniqueNames(messages
    .filter(message => message?.role === 'assistant' && !message?.hidden)
    .map(message => message?.name));
}

export function parseParticipantSelection(value) {
  if (Array.isArray(value)) return uniqueNames(value);
  return uniqueNames(String(value ?? '').split(/[,\n]/));
}

export function selectGroupParticipants(available = [], configured = []) {
  const names = uniqueNames(available);
  const requested = parseParticipantSelection(configured);
  if (!requested.length) return names;
  const wanted = new Set(requested.map(normalizeAlias));
  return names.filter(name => wanted.has(normalizeAlias(name)));
}

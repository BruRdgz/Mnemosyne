import { ENTITY_ID_PATTERN, entityIdFromSeed } from '../domain/ids.js';

export function normalizeAlias(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class EntityRegistry {
  #records = new Map();
  #contextKey = '';

  /**
   * The registry is deliberately hydrateable from the portable envelope.  The
   * first implementation was only an in-memory fixture, which meant that the
   * runtime could not use its alias/ambiguity rules without changing existing
   * entity IDs.  Hydration keeps those IDs authoritative.
   */
  constructor(options = {}) {
    const normalized = Array.isArray(options) ? { records: options } : (options ?? {});
    this.#contextKey = String(normalized.contextKey ?? '');
    if (normalized.records) this.hydrate(normalized.records);
  }

  static fromRecords(records = [], options = {}) {
    return new EntityRegistry({ ...options, records });
  }

  hydrate(records = [], { replace = true } = {}) {
    if (!Array.isArray(records)) throw new TypeError('Entity records must be an array');
    if (replace) this.#records.clear();
    for (const value of records) {
      if (!isEntityRecord(value)) continue;
      this.#records.set(value.id, normalizeRecord(value, this.#contextKey));
    }
    return this.list();
  }

  has(entityId) {
    return this.#records.has(entityId);
  }

  get(entityId) {
    const record = this.#records.get(entityId);
    return record ? structuredClone(record) : null;
  }

  create({ id: requestedId = null, canonicalName, kind = 'character', contextKey = this.#contextKey, senderId = null, provenance = [] }) {
    const name = String(canonicalName ?? '').trim();
    if (!name) throw new TypeError('Canonical entity name is required');
    const scope = String(contextKey ?? '');
    const stableId = entityIdFromSeed(`registry:v2:${kind}:${scope}:${normalizeAlias(name)}`);
    let id = ENTITY_ID_PATTERN.test(requestedId ?? '') ? requestedId : stableId;
    const existing = this.#records.get(id);
    if (existing && normalizeAlias(existing.canonicalName) !== normalizeAlias(name)) {
      id = entityIdFromSeed(`registry:v2:${kind}:${scope}:${normalizeAlias(name)}:${this.#records.size}`);
    }
    const record = { id, canonicalName: name, aliases: [], kind, contextKey: scope, senderId, provenance: cloneList(provenance) };
    this.#records.set(id, record);
    return structuredClone(record);
  }

  /** Record a model/source mention without treating it as a confirmed alias. */
  observeMention({ entityId, mention, aliases = [], kind = 'character', contextKey = this.#contextKey, senderId = null, provenance = [] } = {}) {
    if (!ENTITY_ID_PATTERN.test(entityId ?? '')) throw new TypeError('A valid EntityId is required');
    const value = String(mention ?? '').trim();
    if (!value) throw new TypeError('Entity mention is required');
    const current = this.#records.get(entityId);
    const record = current ?? {
      id: entityId,
      canonicalName: value,
      aliases: [],
      kind,
      contextKey: String(contextKey ?? ''),
      senderId,
      provenance: [],
    };
    if (!record.canonicalName) record.canonicalName = value;
    if (!Array.isArray(record.aliases)) record.aliases = [];
    if (!Array.isArray(record.provenance)) record.provenance = [];
    for (const name of [value, ...aliases].filter(Boolean)) {
      this.#observeAlias(record, name, { provenance, confirmed: false });
    }
    appendUnique(record.provenance, provenance);
    this.#records.set(entityId, record);
    return structuredClone(record);
  }

  propose(mention, { senderId = null, contextKey = this.#contextKey } = {}) {
    const normalized = normalizeAlias(mention);
    const candidates = [...this.#records.values()].map(record => {
      const names = [record.canonicalName, ...(record.aliases ?? []).map(alias => alias?.value ?? alias)].map(normalizeAlias);
      const exact = names.includes(normalized);
      const tokenOverlap = overlap(normalized, names);
      const contextMatch = Boolean(contextKey && record.contextKey === contextKey);
      const senderMatch = Boolean(senderId && record.senderId === senderId);
      const score = (exact ? 1 : tokenOverlap * 0.7) + (contextMatch ? 0.2 : 0) + (senderMatch ? 0.5 : 0);
      return { entityId: record.id, canonicalName: record.canonicalName, score, exact, contextMatch, senderMatch };
    }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
    const best = candidates[0] ?? null;
    const ambiguous = best && candidates[1] && Math.abs(best.score - candidates[1].score) < 0.15;
    return {
      mention,
      proposedEntityId: best && !ambiguous && (best.score >= 0.8 || (best.contextMatch && best.score >= 0.5)) ? best.entityId : null,
      confidence: best?.exact && !ambiguous ? 'high' : best ? 'uncertain' : 'new',
      candidates,
      requiresConfirmation: !best || !best.exact || Boolean(ambiguous),
    };
  }

  addAlias(entityId, value, { provenance = [], confirmed = false } = {}) {
    const record = this.#records.get(entityId);
    if (!record) throw new Error(`Unknown entity: ${entityId}`);
    if (!confirmed) throw new Error('Alias merge requires explicit confirmation');
    const normalized = normalizeAlias(value);
    if (!normalized) throw new TypeError('Alias cannot be empty');
    this.#observeAlias(record, value, { provenance, confirmed: true });
    this.#records.set(entityId, record);
    return structuredClone(record);
  }

  list() {
    return [...this.#records.values()].map(record => structuredClone(record));
  }

  #observeAlias(record, value, { provenance = [], confirmed = false } = {}) {
    const text = String(value ?? '').trim();
    const normalized = normalizeAlias(text);
    if (!normalized || normalized === normalizeAlias(record.canonicalName)) {
      appendUnique(record.provenance, provenance);
      return;
    }
    const existing = record.aliases.find(alias => normalizeAlias(alias?.value ?? alias) === normalized);
    if (existing) {
      if (typeof existing === 'string') {
        const replacement = { value: existing, provenance: [], confirmed: false };
        const index = record.aliases.indexOf(existing);
        record.aliases[index] = replacement;
        appendUnique(replacement.provenance, provenance);
        replacement.confirmed ||= confirmed;
      } else {
        existing.confirmed = Boolean(existing.confirmed || confirmed);
        if (!Array.isArray(existing.provenance)) existing.provenance = [];
        appendUnique(existing.provenance, provenance);
      }
      return;
    }
    const aliasRecord = { value: text, provenance: [], confirmed: Boolean(confirmed) };
    appendUnique(aliasRecord.provenance, provenance);
    record.aliases.push(aliasRecord);
  }
}

function isEntityRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && ENTITY_ID_PATTERN.test(value.id ?? '') && String(value.canonicalName ?? '').trim());
}

function normalizeRecord(value, contextKey = '') {
  const record = structuredClone(value);
  record.canonicalName = String(record.canonicalName).trim();
  record.contextKey = String(record.contextKey ?? contextKey);
  record.aliases = (Array.isArray(record.aliases) ? record.aliases : []).map(alias => typeof alias === 'string'
    ? { value: alias, provenance: [], confirmed: false }
    : { ...structuredClone(alias), value: String(alias?.value ?? '').trim(), provenance: cloneList(alias?.provenance), confirmed: Boolean(alias?.confirmed) })
    .filter(alias => alias.value);
  record.provenance = cloneList(record.provenance);
  return record;
}

function cloneList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? structuredClone(value) : [structuredClone(value)];
}

function appendUnique(target, values) {
  if (!Array.isArray(target)) return;
  const list = Array.isArray(values) ? values : (values === undefined || values === null ? [] : [values]);
  for (const value of list) {
    const key = JSON.stringify(value);
    if (!target.some(existing => JSON.stringify(existing) === key)) target.push(structuredClone(value));
  }
}

function overlap(mention, names) {
  const query = new Set(mention.split(' ').filter(Boolean));
  if (!query.size) return 0;
  let best = 0;
  for (const name of names) {
    const tokens = new Set(name.split(' ').filter(Boolean));
    const common = [...query].filter(token => tokens.has(token)).length;
    best = Math.max(best, common / Math.max(query.size, tokens.size));
  }
  return best;
}

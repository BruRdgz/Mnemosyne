const NUMERIC_FIELDS = Object.freeze([
  'contextBudget', 'contextReserveTokens', 'contextStateBudget', 'contextRegistersBudget', 'contextChronologicalBudget', 'contextAssociativeBudget', 'rawTailBudget', 'commitmentAgeOutSegments', 'segmentTarget', 'segmentSoftMax', 'segmentHardMax',
  'extractionInputBudget', 'rebuildTotalInputBudget', 'extractionMaxOutputTokens', 'extractionStateBudget',
  'extractionChronologicalBudget', 'extractionHistoricalBudget', 'extractionRawPreludeBudget', 'segmentMaxTurnBundles', 'segmentInputSafetyRatio', 'segmentNearOptimalRatio', 'segmentSafeOverheadRatio', 'extractionContinuityStateBudget', 'extractionContinuityRawPreludeBudget', 'extractionRepairStateBudget', 'extractionFallbackDigestBudget', 'memorySessionTokenCap',
  'memoryDailyTokenCap', 'memoryCooldownMs', 'memoryTemperature', 'memoryTopP', 'preemptiveRatio', 'integrityAuditIntervalMessages',
]);
const BOOLEAN_FIELDS = Object.freeze(['autoCompact', 'injectIntoQuietGenerations', 'injectManagedMemory', 'preferFallbackExtraction']);
const ENUM_FIELDS = Object.freeze({ retrievalMode: new Set(['lexical', 'hybrid', 'embedding']), memoryGenerationMode: new Set(['live', 'replay', 'offline']), segmentPlannerMode: new Set(['adaptive_balanced', 'legacy_greedy']) });
const TEXT_FIELDS = Object.freeze(['memoryConnectionProfileId']);
export const PROFILE_FIELDS = Object.freeze([...NUMERIC_FIELDS, ...BOOLEAN_FIELDS, ...Object.keys(ENUM_FIELDS), ...TEXT_FIELDS]);
export const PROFILE_SCOPES = Object.freeze(['default', 'characters', 'groups', 'chats']);

function scopeId(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const result = {};
  for (const key of PROFILE_FIELDS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (NUMERIC_FIELDS.includes(key)) {
      const number = Number(value);
      const upperBound = ['memoryTopP', 'preemptiveRatio', 'segmentInputSafetyRatio'].includes(key) ? 1 : ['memoryTemperature'].includes(key) ? 2 : Infinity;
      if (Number.isFinite(number) && number >= 0 && number <= upperBound) result[key] = number;
      continue;
    }
    if (BOOLEAN_FIELDS.includes(key)) {
      if (typeof value === 'boolean') result[key] = value;
      continue;
    }
    if (ENUM_FIELDS[key]) {
      if (ENUM_FIELDS[key].has(String(value))) result[key] = String(value);
      continue;
    }
    if (TEXT_FIELDS.includes(key)) {
      const text = String(value ?? '').trim();
      result[key] = text || null;
    }
  }
  return result;
}

function tableEntry(table, id) {
  if (!table || typeof table !== 'object' || Array.isArray(table) || !id) return null;
  return table[id] ?? null;
}

function normalizeScope(scope) {
  const value = String(scope ?? '').trim().toLowerCase();
  if (!PROFILE_SCOPES.includes(value)) throw new RangeError(`Unsupported profile scope: ${scope}`);
  return value;
}

function normalizeProfileId(id, scope) {
  if (scope === 'default') return 'default';
  const value = scopeId(id);
  if (!value) throw new TypeError(`A ${scope} profile requires an id`);
  return value;
}

/**
 * Returns only the supported, non-narrative profile fields. This is used for
 * settings-backed character/group editors so arbitrary prompt or story text
 * can never leak into a profile definition.
 */
export function normalizeProfileCatalog(profiles = {}) {
  const source = profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
  const result = { default: cleanPatch(source.default), characters: {}, groups: {}, chats: {} };
  for (const scope of ['characters', 'groups', 'chats']) {
    const table = source[scope];
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [id, patch] of Object.entries(table)) {
      const key = scopeId(id);
      const normalized = cleanPatch(patch);
      if (key && Object.keys(normalized).length) result[scope][key] = normalized;
    }
  }
  return result;
}

export function upsertProfileDefinition(profiles = {}, { scope, id, patch } = {}) {
  const normalizedScope = normalizeScope(scope);
  const normalizedId = normalizeProfileId(id, normalizedScope);
  const result = normalizeProfileCatalog(profiles);
  const normalizedPatch = cleanPatch(patch);
  const current = normalizedScope === 'default' ? result.default : (result[normalizedScope][normalizedId] ?? {});
  if (!Object.keys(normalizedPatch).length) {
    if (normalizedScope === 'default') result.default = {};
    else delete result[normalizedScope][normalizedId];
    return result;
  }
  const merged = cleanPatch({ ...current, ...normalizedPatch });
  if (normalizedScope === 'default') result.default = merged;
  else result[normalizedScope][normalizedId] = merged;
  return result;
}

export function removeProfileDefinition(profiles = {}, { scope, id } = {}) {
  const normalizedScope = normalizeScope(scope);
  const normalizedId = normalizeProfileId(id, normalizedScope);
  const result = normalizeProfileCatalog(profiles);
  if (normalizedScope === 'default') result.default = {};
  else delete result[normalizedScope][normalizedId];
  return result;
}

export function normalizeProfilePatch(patch) {
  return structuredClone(cleanPatch(patch));
}

export function resolveEffectiveProfile({ baseSettings = {}, profiles = {}, identity = {}, chatPreferences = {} } = {}) {
  const values = {};
  const sources = {};
  for (const key of PROFILE_FIELDS) {
    if (baseSettings[key] !== undefined) {
      values[key] = baseSettings[key];
      sources[key] = 'global default';
    }
  }
  const normalizedProfiles = profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
  const layers = [
    [normalizedProfiles.default, 'profile:default'],
    [tableEntry(normalizedProfiles.characters, scopeId(identity.characterId)), `profile:character:${scopeId(identity.characterId) ?? 'none'}`],
    [tableEntry(normalizedProfiles.groups, scopeId(identity.groupId)), `profile:group:${scopeId(identity.groupId) ?? 'none'}`],
    [tableEntry(normalizedProfiles.chats, scopeId(identity.chatId)), `profile:chat:${scopeId(identity.chatId) ?? 'none'}`],
    [chatPreferences?.profileOverrides, 'chat override'],
  ];
  const appliedScopes = [];
  for (const [patch, source] of layers) {
    const normalized = cleanPatch(patch);
    if (!Object.keys(normalized).length) continue;
    appliedScopes.push(source);
    for (const [key, value] of Object.entries(normalized)) {
      values[key] = value;
      sources[key] = source;
    }
  }
  return { values, sources, appliedScopes, identity: { chatId: scopeId(identity.chatId), characterId: scopeId(identity.characterId), groupId: scopeId(identity.groupId) } };
}

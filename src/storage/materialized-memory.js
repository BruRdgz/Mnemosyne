import { ENTITY_ID_PATTERN } from '../domain/ids.js';
import { EntityRegistry } from '../entities/entity-registry.js';
import { SCHEMA_VERSION } from '../domain/schema.js';

export function materializeEntities(segments, { contextKey = '', existing = [] } = {}) {
  const registry = EntityRegistry.fromRecords(existing, { contextKey });
  for (const segment of segments.filter(value => value.status === 'valid' && value.summary)) {
    for (const mention of segment.summary.entities ?? []) {
      const id = mention.proposedEntityId;
      if (!ENTITY_ID_PATTERN.test(id ?? '') || !mention.mention) continue;
      const provenance = { segmentId: segment.id, sourceFingerprint: segment.source?.rangeFingerprint ?? null };
      registry.observeMention({
        entityId: id,
        mention: mention.mention,
        aliases: mention.aliases ?? [],
        contextKey,
        provenance,
      });
    }
  }
  return registry.list().sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
}

export function materializeRegisters(segments) {
  const registers = new Map();
  for (const segment of segments.filter(value => value.status === 'valid' && value.summary)) {
    for (const observation of segment.summary.registerObservations ?? []) {
      const key = observation.registerKey;
      if (!key) continue;
      const register = registers.get(key) ?? {
        key, type: observation.registerType ?? 'generic', lifecycle: 'active', injectionPolicy: 'relevant', observations: [], projection: {}, schemaVersion: SCHEMA_VERSION,
      };
      register.observations.push({ ...structuredClone(observation), provenance: { segmentId: segment.id, sourceFingerprint: segment.source?.rangeFingerprint ?? null } });
      register.projection = { observations: structuredClone(register.observations) };
      registers.set(key, register);
    }
  }
  return [...registers.values()].sort((a, b) => a.key.localeCompare(b.key));
}

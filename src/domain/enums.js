function algebra(values) {
  const list = Object.freeze([...values]);
  return Object.freeze({
    values: list,
    has: value => list.includes(value),
    assert(value, label = 'value') {
      if (!list.includes(value)) throw new TypeError(`${label} must be one of: ${list.join(', ')}`);
      return value;
    },
  });
}

export const MemorySegmentStatus = algebra(['pending', 'valid', 'stale', 'failed', 'excluded']);
export const ModelEvidenceLevel = algebra(['explicit', 'strong_inference', 'weak_inference']);
export const EvidenceLevel = algebra(['explicit', 'strong_inference', 'weak_inference', 'manual', 'deterministic']);
export const PersistenceClass = algebra(['transient', 'active', 'durable', 'historical', 'archived', 'pinned']);
export const ModelPersistenceClass = algebra(['transient', 'active', 'durable', 'historical', 'archived']);
export const Salience = algebra(['minor', 'normal', 'important', 'critical']);
export const EpistemicKind = algebra(['knows', 'believes', 'suspects', 'assumes', 'uncertain']);
export const ChangeOperation = algebra(['add', 'set', 'revise', 'remove', 'transition']);
export const CommitmentStatus = algebra(['made', 'active', 'kept', 'broken', 'released', 'obsolete', 'superseded', 'unknown']);
export const ThreadStatus = algebra(['open', 'active', 'advanced', 'resolved', 'reopened', 'abandoned', 'unknown']);
export const ActivityStatus = algebra(['active', 'paused', 'completed', 'abandoned', 'superseded', 'unknown']);
export const BoundaryStatus = algebra(['active', 'revised', 'released', 'superseded', 'unknown']);
export const RegisterLifecycle = algebra(['active', 'completed', 'archived', 'invalid', 'unknown']);
export const RegisterInjectionPolicy = algebra(['always', 'relevant', 'manual', 'archived']);
export const ConflictStatus = algebra(['unresolved', 'resolved', 'dismissed']);
export const MemoryDomain = algebra([
  'general', 'relationship', 'romantic', 'sexual', 'family', 'social', 'physical',
  'career', 'education', 'competition', 'world', 'location', 'temporal', 'resource', 'other',
]);
export const RelationshipDimension = algebra([
  'formal_status', 'domestic_status', 'emotional_closeness', 'trust', 'current_conflict',
  'romantic_attraction', 'romantic_intent', 'sexual_attraction', 'sexual_intent',
  'physical_affection', 'romantic_history', 'sexual_history', 'exclusivity',
  'boundary', 'reconciliation',
]);
export const RegisterObservationKind = algebra(['event_result', 'amendment', 'snapshot', 'generic']);
export const TemporalEvidenceKind = algebra(['exact', 'relative', 'approximate', 'ordering', 'deadline']);
export const LocationEvidenceKind = algebra(['scene', 'presence', 'residence', 'workplace', 'destination', 'relocation']);

export { algebra };

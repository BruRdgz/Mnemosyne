import { fnv1a64 } from '../domain/ids.js';

export class ConflictDetector {
  #claims = new Map();
  #conflicts = new Map();

  ingest(summary, { segmentId, sourceFingerprint }) {
    for (const observation of summary.observations ?? []) {
      if (observation.evidence !== 'explicit' || !observation.subject || !observation.predicate) continue;
      const key = `${observation.subject}:${observation.predicate}`;
      const claim = { value: structuredClone(observation.value), description: observation.description, segmentId, sourceFingerprint };
      const prior = this.#claims.get(key);
      if (prior && JSON.stringify(prior.value) !== JSON.stringify(claim.value) && observation.supersedes !== true) {
        const id = `conflict_${fnv1a64(key)}`;
        this.#conflicts.set(id, {
          id,
          subject: observation.subject,
          property: observation.predicate,
          candidates: [prior, claim],
          status: 'unresolved',
        });
      }
      this.#claims.set(key, claim);
    }
    return this.list();
  }

  resolve(id, resolution) {
    const conflict = this.#conflicts.get(id);
    if (!conflict) throw new Error(`Unknown conflict: ${id}`);
    conflict.status = 'resolved';
    conflict.resolution = structuredClone(resolution);
    return structuredClone(conflict);
  }

  list({ status = null } = {}) {
    return [...this.#conflicts.values()].filter(conflict => !status || conflict.status === status).map(conflict => structuredClone(conflict));
  }
}

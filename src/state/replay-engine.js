import { fingerprintValue } from '../domain/fingerprint.js';
import { NarrativeStateReducer } from './narrative-reducer.js';

function usable(segment) {
  return segment?.status === 'valid' && segment.summary;
}

export function prefixFingerprint(segments, endExclusive) {
  return fingerprintValue(segments.slice(0, endExclusive).map(segment => ({
    id: segment.id,
    source: segment.source?.rangeFingerprint,
    status: segment.status,
    updatedAt: segment.updatedAt,
  })), 'replay-prefix');
}

export class ReplayEngine {
  #checkpointInterval;
  #metrics;
  #cardCanon;

  constructor({ checkpointInterval = 50, metrics = null, cardCanon = {} } = {}) {
    if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) throw new TypeError('checkpointInterval must be positive');
    this.#checkpointInterval = checkpointInterval;
    this.#metrics = metrics;
    this.#cardCanon = cardCanon;
  }

  replay(segments, { checkpoint = null } = {}) {
    const finish = this.#metrics?.measure('state_replay', { segmentCount: segments.length });
    let start = 0;
    let checkpointLoaded = false;
    let reducer;
    if (checkpoint && this.isCheckpointValid(checkpoint, segments)) {
      start = checkpoint.frontier;
      checkpointLoaded = true;
      reducer = new NarrativeStateReducer({ initialState: checkpoint.state });
    } else reducer = new NarrativeStateReducer({ cardCanon: this.#cardCanon });

    const checkpoints = [];
    let observationsReplayed = 0;
    for (let index = start; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!usable(segment)) continue;
      reducer.applyEpisode(segment.summary, { segmentId: segment.id });
      observationsReplayed += countDeltas(segment.summary);
      const frontier = index + 1;
      if (frontier % this.#checkpointInterval === 0 || frontier === segments.length) {
        checkpoints.push(Object.freeze({
          frontier,
          prefixFingerprint: prefixFingerprint(segments, frontier),
          state: reducer.snapshot(),
          createdAt: Date.now(),
        }));
      }
    }
    const result = {
      state: reducer.snapshot(),
      history: reducer.history(),
      checkpoints,
      checkpointLoaded,
      segmentsReplayed: segments.length - start,
      observationsReplayed,
    };
    finish?.({
      status: 'success', checkpointLoaded, segmentsReplayed: result.segmentsReplayed,
      observationsReplayed, checkpointCount: checkpoints.length,
    });
    return result;
  }

  isCheckpointValid(checkpoint, segments) {
    return Number.isInteger(checkpoint.frontier)
      && checkpoint.frontier >= 0
      && checkpoint.frontier <= segments.length
      && checkpoint.prefixFingerprint === prefixFingerprint(segments, checkpoint.frontier);
  }

  replayFrom(segments, startIndex, checkpoints = []) {
    const candidate = [...checkpoints]
      .filter(checkpoint => checkpoint.frontier <= startIndex && this.isCheckpointValid(checkpoint, segments))
      .sort((a, b) => b.frontier - a.frontier)[0] ?? null;
    return this.replay(segments, { checkpoint: candidate });
  }
}

function countDeltas(summary) {
  return ['observations', 'stateChanges', 'knowledgeChanges', 'relationshipChanges', 'commitments', 'threads', 'salientNegatives', 'registerObservations']
    .reduce((sum, key) => sum + (summary[key]?.length ?? 0), 0);
}

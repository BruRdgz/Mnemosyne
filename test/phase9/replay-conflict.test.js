import assert from 'node:assert/strict';
import test from 'node:test';
import { entityIdFromSeed } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';
import { ConflictDetector } from '../../src/state/conflict-detector.js';
import { ReplayEngine } from '../../src/state/replay-engine.js';

const peter = entityIdFromSeed('peter');

function segment(index, value = `state-${index}`) {
  const summary = emptyEpisodeSummary(`Episode ${index}`);
  summary.stateChanges.push({ subject: peter, path: 'currentCondition.phase', operation: 'set', value, evidence: 'explicit', persistence: 'active' });
  return {
    id: `S${index}`, status: 'valid', updatedAt: index, summary,
    source: { rangeFingerprint: `fp-${index}` },
  };
}

test('Phase 9: 300-segment state replay is deterministic and consolidates current truth', () => {
  const segments = Array.from({ length: 300 }, (_, index) => segment(index));
  const engine = new ReplayEngine({ checkpointInterval: 50 });
  const first = engine.replay(segments);
  const second = engine.replay(structuredClone(segments));
  assert.deepEqual(first.state, second.state);
  assert.equal(first.state.characters[peter].currentCondition.phase, 'state-299');
  assert.equal(first.history.length, 300);
  assert.equal(first.checkpoints.length, 6);
});

test('Phase 9: valid checkpoint replay equals full replay with fewer segments', () => {
  const segments = Array.from({ length: 120 }, (_, index) => segment(index));
  const engine = new ReplayEngine({ checkpointInterval: 40 });
  const full = engine.replay(segments);
  const checkpoint = full.checkpoints.find(item => item.frontier === 80);
  const resumed = engine.replay(segments, { checkpoint });
  assert.equal(resumed.checkpointLoaded, true);
  assert.equal(resumed.segmentsReplayed, 40);
  assert.deepEqual(resumed.state, full.state);
});

test('Phase 9: stale checkpoint is ignored after old source mutation', () => {
  const segments = Array.from({ length: 100 }, (_, index) => segment(index));
  const engine = new ReplayEngine({ checkpointInterval: 50 });
  const checkpoint = engine.replay(segments).checkpoints[0];
  segments[10] = { ...segments[10], updatedAt: 999, source: { rangeFingerprint: 'edited' } };
  const replayed = engine.replay(segments, { checkpoint });
  assert.equal(replayed.checkpointLoaded, false);
  assert.equal(replayed.segmentsReplayed, 100);
});

test('Phase 9: targeted rebuild chooses the newest valid checkpoint before target', () => {
  const segments = Array.from({ length: 120 }, (_, index) => segment(index));
  const engine = new ReplayEngine({ checkpointInterval: 20 });
  const full = engine.replay(segments);
  const targeted = engine.replayFrom(segments, 85, full.checkpoints);
  assert.equal(targeted.checkpointLoaded, true);
  assert.equal(targeted.segmentsReplayed, 40, 'frontier 80 chosen');
  assert.deepEqual(targeted.state, full.state);
});

test('Phase 9: replay metrics report scaling and checkpoint use', () => {
  let tick = 0;
  const metrics = new MetricsRecorder({ now: () => ++tick });
  const segments = Array.from({ length: 20 }, (_, index) => segment(index));
  const engine = new ReplayEngine({ checkpointInterval: 10, metrics });
  const full = engine.replay(segments);
  engine.replay(segments, { checkpoint: full.checkpoints[0] });
  const events = metrics.snapshot();
  assert.equal(events[0].segmentsReplayed, 20);
  assert.equal(events[1].checkpointLoaded, true);
  assert.equal(events[1].segmentsReplayed, 10);
});

test('Phase 9: normal explicit supersession does not create a conflict', () => {
  const detector = new ConflictDetector();
  const first = emptyEpisodeSummary('First.');
  first.observations.push({ subject: peter, predicate: 'job', value: 'student', description: 'Peter is a student', evidence: 'explicit', persistence: 'durable', salience: 'normal', domains: ['career'] });
  const second = emptyEpisodeSummary('Correction.');
  second.observations.push({ subject: peter, predicate: 'job', value: 'reporter', description: 'Peter is now a reporter', evidence: 'explicit', supersedes: true, persistence: 'durable', salience: 'normal', domains: ['career'] });
  detector.ingest(first, { segmentId: 'S1', sourceFingerprint: 'fp1' });
  assert.equal(detector.ingest(second, { segmentId: 'S2', sourceFingerprint: 'fp2' }).length, 0);
});

test('Phase 9: genuine explicit contradiction is surfaced and not silently resolved', () => {
  const detector = new ConflictDetector();
  const age10 = emptyEpisodeSummary('Claim one.');
  age10.observations.push({ subject: peter, predicate: 'father_death_age', value: 10, description: 'Father died at 10', evidence: 'explicit', persistence: 'durable', salience: 'important', domains: ['family'] });
  const age14 = emptyEpisodeSummary('Claim two.');
  age14.observations.push({ subject: peter, predicate: 'father_death_age', value: 14, description: 'Father died at 14', evidence: 'explicit', persistence: 'durable', salience: 'important', domains: ['family'] });
  detector.ingest(age10, { segmentId: 'S1', sourceFingerprint: 'fp1' });
  const conflicts = detector.ingest(age14, { segmentId: 'S2', sourceFingerprint: 'fp2' });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, 'unresolved');
  assert.equal(conflicts[0].candidates.length, 2);
  detector.resolve(conflicts[0].id, { selectedSegmentId: 'S1', provenance: 'manual' });
  assert.equal(detector.list()[0].status, 'resolved');
});

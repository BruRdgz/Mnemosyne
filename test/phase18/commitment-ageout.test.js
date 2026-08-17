import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommitmentAgeOut, projectNarrativeState } from '../../src/state/state-projector.js';
import { normalizeProfilePatch } from '../../src/config/profile-resolver.js';

const peter = 'ent_0000000000000001';

function segment(id, index, commitments = []) {
  return {
    id,
    source: {
      first: { messageIndex: index * 2 },
      last: { messageIndex: index * 2 + 1 },
      rangeFingerprint: `${id}-fp`,
    },
    summary: { commitments },
  };
}

test('Phase 18: commitment age-out is projection-only and preserves the source state', () => {
  const segments = [
    segment('seg-1', 0, [{ id: 'old', actor: peter, content: 'Check the lock', transition: 'made', evidence: 'explicit' }]),
    segment('seg-2', 1),
    segment('seg-3', 2),
    segment('seg-4', 3),
  ];
  const state = {
    commitments: { old: { id: 'old', actor: peter, content: 'Check the lock', status: 'active' } },
    characters: { [peter]: { commitments: { old: 'active' } } },
  };

  const result = applyCommitmentAgeOut(state, segments, { maxSegments: 3 });
  assert.deepEqual(state.commitments.old.content, 'Check the lock');
  assert.equal(result.state.commitments.old, undefined);
  assert.equal(result.state.characters[peter].commitments.old, undefined);
  assert.equal(result.agedOut[0].ageSegments, 3);
  assert.equal(result.agedOut[0].sourceSegmentId, 'seg-1');
  assert.deepEqual(projectNarrativeState(state, { segments, commitmentAgeOutSegments: 3 }), []);
});

test('Phase 18: a later commitment transition refreshes age and zero disables the safety valve', () => {
  const segments = [
    segment('seg-1', 0, [{ id: 'promise', actor: peter, content: 'Bring notes', transition: 'made', evidence: 'explicit' }]),
    segment('seg-2', 1),
    segment('seg-3', 2, [{ id: 'promise', actor: peter, content: 'Bring notes', transition: 'active', evidence: 'explicit' }]),
    segment('seg-4', 3),
  ];
  const state = { commitments: { promise: { id: 'promise', actor: peter, content: 'Bring notes', status: 'active' } } };
  assert.equal(applyCommitmentAgeOut(state, segments, { maxSegments: 2 }).agedOut.length, 0);
  assert.equal(applyCommitmentAgeOut(state, segments, { maxSegments: 0 }).agedOut.length, 0);
  assert.equal(normalizeProfilePatch({ commitmentAgeOutSegments: 6 }).commitmentAgeOutSegments, 6);
  assert.equal(normalizeProfilePatch({ commitmentAgeOutSegments: -1 }).commitmentAgeOutSegments, undefined);
});

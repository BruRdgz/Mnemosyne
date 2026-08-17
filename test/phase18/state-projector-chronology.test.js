import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNarrativeState } from '../../src/state/state-projector.js';
import { ContextCompiler } from '../../src/context/context-compiler.js';

const peter = 'ent_0000000000000001';
const jean = 'ent_0000000000000002';

function segment(id, first, last, commitments = []) {
  return {
    id,
    source: { first: { messageIndex: first }, last: { messageIndex: last }, rangeFingerprint: `${id}-fp` },
    summary: { commitments },
  };
}

test('Phase 18: projected state uses canonical names and chronological source labels while retaining internal keys', () => {
  const segments = [
    segment('seg_first', 0, 3, [{ id: 'promise', actor: peter, toward: jean, content: 'Bring the notes', transition: 'made' }]),
    segment('seg_latest', 4, 7, [{ id: 'promise', actor: peter, toward: jean, content: 'Bring the notes tomorrow', transition: 'made' }]),
  ];
  const projected = projectNarrativeState({ commitments: {
    promise: { id: 'promise', actor: peter, toward: jean, content: 'Bring the notes tomorrow', status: 'active' },
  } }, {
    entityRecords: [
      { id: peter, canonicalName: 'Peter Parker' },
      { id: jean, canonicalName: 'Jean Grey' },
    ],
    segments,
  });

  assert.equal(projected[0].id, 'state:commitment:promise');
  assert.match(projected[0].text, /^\[S02 · msgs 4–7\] Commitment \(active\): Peter Parker to Jean Grey/);
  assert.match(projected[0].text, /Bring the notes tomorrow/);
  assert.doesNotMatch(projected[0].text, /ent_000000000000000/);
  assert.deepEqual(projected[0].chronology, { segmentId: 'seg_latest', segmentOrdinal: 2, firstMessage: 4, lastMessage: 7, sourceFingerprint: 'seg_latest-fp' });
});

test('Phase 18: context compiler preserves chronological labels and explains their meaning', async () => {
  const compiler = new ContextCompiler({ countTokens: async text => String(text).trim() ? String(text).trim().split(/\s+/).length : 0 });
  const segments = [segment('seg_old', 0, 1, [{ id: 'old', actor: peter, content: 'Check the lock', transition: 'made' }])];
  const state = projectNarrativeState({ commitments: {
    old: { id: 'old', actor: peter, content: 'Check the lock', status: 'active' },
  } }, { entityRecords: [{ id: peter, canonicalName: 'Peter Parker' }], segments });
  const compiled = await compiler.compile({ state, rawMessages: [{ index: 2, role: 'user', text: 'Continue', required: true }] }, { hardTotal: 100, state: 40, raw: 30, registers: 0, chronological: 0, associative: 0 });

  assert.match(compiled.block, /Memory labels use S##/);
  assert.match(compiled.block, /\[S01 · msgs 0–1\]/);
  assert.match(compiled.block, /Peter Parker/);
  assert.doesNotMatch(compiled.block, /ent_0000000000000001/);
});

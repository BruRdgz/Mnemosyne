import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGroupParticipants, parseParticipantSelection, selectGroupParticipants } from '../../src/retrieval/group-participants.js';

test('Phase 18: group participant selection is deterministic, name-normalized, and opt-in', () => {
  const messages = [
    { role: 'assistant', name: 'Jean Grey', hidden: false },
    { role: 'assistant', name: 'Peter Parker', hidden: false },
    { role: 'assistant', name: 'jean grey', hidden: false },
    { role: 'assistant', name: 'System', hidden: true },
    { role: 'user', name: 'User', hidden: false },
  ];
  assert.deepEqual(collectGroupParticipants(messages), ['Jean Grey', 'Peter Parker']);
  assert.deepEqual(parseParticipantSelection('peter parker, Jean Grey\nJean Grey'), ['peter parker', 'Jean Grey']);
  assert.deepEqual(selectGroupParticipants(['Jean Grey', 'Peter Parker'], []), ['Jean Grey', 'Peter Parker']);
  assert.deepEqual(selectGroupParticipants(['Jean Grey', 'Peter Parker'], ['peter parker']), ['Peter Parker']);
  assert.deepEqual(selectGroupParticipants(['Jean Grey', 'Peter Parker'], ['Unknown']), []);
});

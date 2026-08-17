import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMnemosyneSlashCommands, mnemosyneCommandAudit, mnemosyneCommandStatus } from '../../src/integration/slash-commands.js';

function fixture() {
  const commands = {};
  const parser = {
    commands,
    addCommand(name, callback, aliases = [], helpString = '') {
      const command = { name, callback, aliases, helpString };
      commands[name] = command;
      for (const alias of aliases) commands[alias] = command;
    },
  };
  const calls = [];
  const runtime = {
    generationStatus: () => ({ mode: 'live', operation: 'idle', currentSegmentOrdinal: null, totalSegments: 0, replaySessionId: null, availableSegmentCount: 0, missingSegmentCount: 0, availableAttemptCount: 0 }),
    backfillStatus: () => ({ status: 'idle', analysis: { plannedSegmentCount: 0, preservedValidCount: 2, executionMode: 'live' } }),
    integrityStatus: () => ({ status: 'valid', checkedSegments: 2, staleSegments: 0, firstChangedIndex: null }),
    tokenStatus: () => ({ session: { spent: 40 }, daily: { spent: 100 }, reserved: 0, ledgerHealthy: true }),
    auditIntegrity: async () => { calls.push(['audit']); return { status: 'valid' }; },
    snapshot: () => ({ rebuildSessions: [{ id: 'rb-1', status: 'incomplete', updatedAt: 4 }, { id: 'rb-old', status: 'complete', updatedAt: 2 }] }),
    setGenerationMode: mode => { calls.push(['mode', mode]); return { mode }; },
    pauseBackfill: () => { calls.push(['pause']); return true; },
    resumeRebuild: async (...args) => { calls.push(['resume', ...args]); return { session: { id: args[0], status: 'incomplete' } }; },
    replayRebuild: async (...args) => { calls.push(['replay', ...args]); return { session: { id: args[0], status: 'complete' } }; },
    analyzeSegmentRegeneration: async id => { calls.push(['analyze', id]); return { segmentId: id, executionMode: 'live', estimatedRequests: 1, projection: { tokens: { input: 20, output: 10 } } }; },
    regenerateSegment: async (...args) => { calls.push(['repair', ...args]); return { session: { id: 'repair-session', status: 'incomplete' } }; },
  };
  return { parser, runtime, calls };
}

test('Phase 18: slash commands register once, expose no narrative, and dispose cleanly', () => {
  const source = fixture();
  const dispose = registerMnemosyneSlashCommands(source);
  assert.equal(typeof source.parser.commands['mnemosyne-status'].callback, 'function');
  assert.match(mnemosyneCommandStatus(source.runtime), /mode=live/);
  const audit = mnemosyneCommandAudit(source.runtime);
  assert.deepEqual(audit.integrity, { status: 'valid', checkedSegments: 2, staleSegments: 0, firstChangedIndex: null });
  assert.doesNotMatch(JSON.stringify(audit), /synopsis|source-|private/);
  assert.equal(registerMnemosyneSlashCommands(source), dispose);
  dispose();
  assert.equal(source.parser.commands['mnemosyne-status'], undefined);
  assert.equal(source.parser.commands['mnemo-status'], undefined);
});

test('Phase 18: mode, pause, and audit commands remain provider-free', async () => {
  const source = fixture();
  const dispose = registerMnemosyneSlashCommands(source);
  assert.match(await source.parser.commands['mnemosyne-mode'].callback({}, 'offline'), /offline/);
  assert.match(await source.parser.commands['mnemosyne-pause'].callback(), /pause/);
  assert.match(await source.parser.commands['mnemosyne-audit'].callback(), /"mode":"live"/);
  assert.deepEqual(source.calls, [['mode', 'offline'], ['pause'], ['audit']]);
  dispose();
});

test('Phase 18: resume requires explicit confirmation and defaults to newest incomplete session', async () => {
  const source = fixture();
  const dispose = registerMnemosyneSlashCommands(source);
  const command = source.parser.commands['mnemosyne-resume'].callback;
  assert.match(await command({}, ''), /requires confirm=true/);
  assert.deepEqual(source.calls, []);
  assert.match(await command({ confirm: 'true' }, ''), /rb-1/);
  assert.deepEqual(source.calls, [['resume', 'rb-1', { autoPromote: false }]]);
  dispose();
});

test('Phase 18: replay uses recorded outputs and repair analyzes before spending', async () => {
  const source = fixture();
  const dispose = registerMnemosyneSlashCommands(source);
  const replay = source.parser.commands['mnemosyne-replay'].callback;
  assert.match(await replay({}, 'rb-1'), /0 new requests/);
  const repair = source.parser.commands['mnemosyne-repair'].callback;
  assert.match(await repair({}, 'segment-1'), /No request was started/);
  assert.deepEqual(source.calls, [['replay', 'rb-1', { autoPromote: false }], ['analyze', 'segment-1']]);
  assert.match(await repair({ confirm: 'true' }, 'segment-1'), /active baseline unchanged/);
  assert.deepEqual(source.calls.at(-1), ['repair', 'segment-1', { autoPromote: false }]);
  dispose();
});

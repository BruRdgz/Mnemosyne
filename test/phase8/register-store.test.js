import assert from 'node:assert/strict';
import test from 'node:test';
import { RegisterStore, StandingsReducer, TournamentReducer } from '../../src/registers/register-store.js';

function seasonStore() {
  const store = new RegisterStore();
  store.registerReducer('championship', new StandingsReducer({ pointsByPosition: { 1: 10, 2: 6, 3: 4 } }));
  store.create({ key: 'wrc', type: 'championship', injectionPolicy: 'always' });
  return store;
}

test('Phase 8: generic persistent register envelope is versioned', () => {
  const register = seasonStore().get('wrc');
  assert.equal(register.schemaVersion, 1);
  assert.equal(register.lifecycle, 'active');
  assert.deepEqual(register.observations, []);
});

test('Phase 8: unmentioned standings persist unchanged through silence', () => {
  const store = seasonStore();
  store.apply({ kind: 'event_result', registerKey: 'wrc', eventKey: 'round1', entries: [{ subject: 'edward', position: 1 }, { subject: 'loeb', position: 2 }], evidence: 'explicit' });
  const before = store.get('wrc');
  store.applyEpisode([]);
  assert.deepEqual(store.get('wrc'), before);
});

test('Phase 8: event results are scored deterministically', () => {
  const store = seasonStore();
  store.apply({ kind: 'event_result', registerKey: 'wrc', eventKey: 'r1', entries: [{ subject: 'edward', position: 1 }, { subject: 'loeb', position: 2 }], evidence: 'explicit' });
  store.apply({ kind: 'event_result', registerKey: 'wrc', eventKey: 'r2', entries: [{ subject: 'loeb', position: 1 }, { subject: 'edward', position: 3 }], evidence: 'explicit' });
  assert.deepEqual(store.get('wrc').projection.standings, [
    { subject: 'loeb', points: 16, position: 1 },
    { subject: 'edward', points: 14, position: 2 },
  ]);
});

test('Phase 8: result amendment recomputes the table from observations', () => {
  const store = seasonStore();
  store.apply({ kind: 'event_result', registerKey: 'wrc', eventKey: 'r1', entries: [{ subject: 'edward', position: 1 }, { subject: 'loeb', position: 2 }], evidence: 'explicit' });
  store.apply({ kind: 'amendment', registerKey: 'wrc', eventKey: 'r1', subject: 'edward', supersedes: { position: 1 }, newValue: { position: 3 }, reason: 'penalty', evidence: 'explicit' });
  assert.deepEqual(store.get('wrc').projection.standings, [
    { subject: 'loeb', points: 6, position: 1 },
    { subject: 'edward', points: 4, position: 2 },
  ]);
  assert.equal(store.get('wrc').observations.length, 2);
});

test('Phase 8: partial snapshot updates known rows without deleting unknown rows', () => {
  const store = seasonStore();
  store.apply({ kind: 'snapshot', registerKey: 'wrc', values: [{ subject: 'edward', points: 47 }, { subject: 'loeb', points: 43 }], completeness: 'partial', evidence: 'explicit' });
  store.apply({ kind: 'snapshot', registerKey: 'wrc', values: [{ subject: 'edward', points: 50 }], completeness: 'partial', evidence: 'explicit' });
  const rows = store.get('wrc').projection.partialSnapshotRows;
  assert.equal(rows.edward.points, 50);
  assert.equal(rows.loeb.points, 43);
});

test('Phase 8: tournament final remains pending until explicit completion', () => {
  const store = new RegisterStore();
  store.registerReducer('tournament', new TournamentReducer());
  store.create({ key: 'cup', type: 'tournament' });
  store.apply({ kind: 'event_result', registerKey: 'cup', eventKey: 'final', round: 'final', complete: false, entries: [{ subject: 'alice', result: 'win' }, { subject: 'bob', result: 'loss' }], evidence: 'explicit' });
  assert.equal(store.get('cup').projection.finalPending, true);
  assert.equal(store.get('cup').projection.champion, null);
  store.apply({ kind: 'event_result', registerKey: 'cup', eventKey: 'final', round: 'final', complete: true, entries: [{ subject: 'alice', result: 'win' }, { subject: 'bob', result: 'loss' }], evidence: 'explicit' });
  assert.equal(store.get('cup').projection.champion, 'alice');
});

test('Phase 8: register lifecycle supports active/completed/archived', () => {
  const store = seasonStore();
  assert.equal(store.setLifecycle('wrc', 'completed').lifecycle, 'completed');
  assert.equal(store.setLifecycle('wrc', 'archived').lifecycle, 'archived');
  assert.throws(() => store.setLifecycle('wrc', 'forgotten'), /Schema validation/);
});

test('Phase 8: injection policies always/relevant/manual/archived are enforced', () => {
  const store = seasonStore();
  store.create({ key: 'debt', type: 'generic', injectionPolicy: 'relevant' });
  store.create({ key: 'inventory', type: 'generic', injectionPolicy: 'manual' });
  assert.deepEqual(store.selectForInjection().map(r => r.key), ['wrc']);
  assert.deepEqual(store.selectForInjection({ relevantKeys: ['debt'], manualKeys: ['inventory'] }).map(r => r.key), ['wrc', 'debt', 'inventory']);
  store.setLifecycle('wrc', 'archived');
  assert.equal(store.selectForInjection().some(r => r.key === 'wrc'), false);
  store.setInjectionPolicy('wrc', 'archived');
  assert.equal(store.selectForInjection({ relevantKeys: ['wrc'] }).some(r => r.key === 'wrc'), true);
});

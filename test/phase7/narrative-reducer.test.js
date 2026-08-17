import assert from 'node:assert/strict';
import test from 'node:test';
import { entityIdFromSeed } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { NarrativeStateReducer } from '../../src/state/narrative-reducer.js';

const peter = entityIdFromSeed('peter');
const mj = entityIdFromSeed('mj');
const felicia = entityIdFromSeed('felicia');

test('Phase 7: CharacterState is sparse and explicit cinnamon preference survives silence', () => {
  const reducer = new NarrativeStateReducer();
  const first = emptyEpisodeSummary('MJ states a preference.');
  first.stateChanges.push({ subject: mj, path: 'preferences.coffee.flavor', operation: 'set', value: { disposition: 'dislikes', value: 'cinnamon' }, evidence: 'explicit', persistence: 'durable' });
  reducer.applyEpisode(first);
  reducer.applyEpisode(emptyEpisodeSummary('Unrelated scene.'));
  const state = reducer.snapshot().characters[mj];
  assert.deepEqual(state.preferences.coffee.flavor, { disposition: 'dislikes', value: 'cinnamon' });
  assert.equal(Object.hasOwn(state, 'orientation'), false);
});

test('Phase 7: one situational choice is not promoted to durable preference', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('Peter refuses a drink while driving.');
  episode.stateChanges.push({ subject: peter, path: 'preferences.alcohol', operation: 'set', value: 'dislikes', evidence: 'strong_inference', persistence: 'durable' });
  reducer.applyEpisode(episode);
  assert.equal(reducer.snapshot().characters[peter].preferences.alcohol, undefined);
});

test('Phase 7: ongoing activity persists through silence and transitions explicitly', () => {
  const reducer = new NarrativeStateReducer();
  const start = emptyEpisodeSummary('Training begins.');
  start.stateChanges.push({ subject: peter, path: 'ongoingActivities.training', operation: 'set', value: { status: 'active' }, evidence: 'explicit', persistence: 'active' });
  reducer.applyEpisode(start);
  reducer.applyEpisode(emptyEpisodeSummary('Dinner scene.'));
  assert.equal(reducer.snapshot().characters[peter].ongoingActivities.training.status, 'active');
  const done = emptyEpisodeSummary('Training ends.');
  done.stateChanges.push({ subject: peter, path: 'ongoingActivities.training', operation: 'set', value: { status: 'completed' }, evidence: 'explicit', persistence: 'historical' });
  reducer.applyEpisode(done);
  assert.equal(reducer.snapshot().characters[peter].ongoingActivities.training.status, 'completed');
});

test('Phase 7: injury current condition supersedes while historical deltas remain', () => {
  const reducer = new NarrativeStateReducer();
  for (const value of ['injured', 'improving', 'healed']) {
    const episode = emptyEpisodeSummary(value);
    episode.stateChanges.push({ subject: peter, path: 'currentCondition.ribs', operation: 'set', value, evidence: 'explicit', persistence: value === 'healed' ? 'durable' : 'active' });
    reducer.applyEpisode(episode);
  }
  assert.equal(reducer.snapshot().characters[peter].currentCondition.ribs, 'healed');
  assert.equal(reducer.history().length, 3);
});

test('Phase 7: scalar and nested state paths coexist without replay failure', () => {
  const reducer = new NarrativeStateReducer();
  const first = emptyEpisodeSummary('Condition is summarized.');
  first.stateChanges.push({ subject: peter, path: 'currentCondition', operation: 'set', value: 'asleep', evidence: 'explicit', persistence: 'active' });
  const second = emptyEpisodeSummary('Location is refined.');
  second.stateChanges.push({ subject: peter, path: 'currentCondition.location', operation: 'set', value: 'guest room', evidence: 'explicit', persistence: 'active' });
  reducer.applyEpisode(first);
  reducer.applyEpisode(second);
  assert.equal(reducer.snapshot().characters[peter].currentCondition._value, 'asleep');
  assert.equal(reducer.snapshot().characters[peter].currentCondition.location, 'guest room');
});

test('Phase 7: only continuity-relevant possessions enter state', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('Objects.');
  episode.stateChanges.push({ subject: peter, path: 'possessions.spoon', operation: 'set', value: { location: 'table' }, evidence: 'explicit', persistence: 'transient' });
  episode.stateChanges.push({ subject: peter, path: 'possessions.stolenLedger', operation: 'set', value: { location: 'safe', continuityRelevant: true }, evidence: 'explicit', persistence: 'durable' });
  reducer.applyEpisode(episode);
  const possessions = reducer.snapshot().characters[peter].possessions;
  assert.equal(possessions.spoon, undefined);
  assert.equal(possessions.stolenLedger.location, 'safe');
});

test('Phase 7: private knowledge, suspicion, narrator truth, and world truth remain scoped', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('Epistemics.');
  episode.knowledgeChanges.push({ holder: peter, proposition: 'Felicia sent the message', kind: 'knows', operation: 'add', evidence: 'explicit' });
  episode.knowledgeChanges.push({ holder: mj, proposition: 'Peter enjoys the attention', kind: 'suspects', operation: 'add', evidence: 'strong_inference' });
  episode.observations.push({ value: true, description: 'Peter privately enjoys attention', predicate: 'peter_private_enjoyment', evidence: 'explicit', epistemicScope: 'narrator', persistence: 'historical', salience: 'normal', domains: ['relationship'] });
  episode.observations.push({ value: true, description: 'The message exists', predicate: 'message_exists', evidence: 'explicit', epistemicScope: 'world', persistence: 'historical', salience: 'normal', domains: ['world'] });
  reducer.applyEpisode(episode);
  const state = reducer.snapshot();
  assert.equal(state.characters[peter].knowledge['Felicia sent the message'].kind, 'knows');
  assert.equal(state.characters[mj].knowledge['Peter enjoys the attention'].kind, 'suspects');
  assert.equal(state.characters[mj].knowledge['Peter enjoys the attention'].kind === 'knows', false);
  assert.ok(state.narratorFacts.peter_private_enjoyment);
  assert.ok(state.worldFacts.message_exists);
});

test('Phase 7: relationship dimensions remain independent with no forbidden implications', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('Relationship evidence.');
  episode.relationshipChanges.push({ participants: [peter, mj], dimension: 'formal_status', operation: 'set', value: 'exes', evidence: 'explicit' });
  episode.relationshipChanges.push({ participants: [peter, mj], dimension: 'trust', operation: 'set', value: 'repairing', evidence: 'explicit' });
  episode.relationshipChanges.push({ participants: [peter, mj], dimension: 'emotional_closeness', operation: 'set', value: 'high', evidence: 'explicit' });
  episode.relationshipChanges.push({ participants: [peter, mj], dimension: 'sexual_history', operation: 'add', value: 'prior encounter', evidence: 'explicit' });
  reducer.applyEpisode(episode);
  const rel = Object.values(reducer.snapshot().relationships)[0];
  assert.equal(rel.formal_status, 'exes');
  assert.equal(rel.trust, 'repairing');
  assert.equal(rel.emotional_closeness, 'high');
  assert.deepEqual(rel.sexual_history, ['prior encounter']);
  for (const absent of ['romantic_attraction', 'sexual_attraction', 'romantic_intent', 'sexual_intent', 'exclusivity']) assert.equal(rel[absent], undefined);
});

test('Phase 7: kiss/sex do not imply status and inferred identity label is rejected', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('A kiss occurs.');
  episode.relationshipChanges.push({ participants: [peter, felicia], dimension: 'romantic_history', operation: 'add', value: 'kiss', evidence: 'explicit' });
  episode.stateChanges.push({ subject: peter, path: 'identity.orientation', operation: 'set', value: 'label', evidence: 'strong_inference', persistence: 'durable' });
  reducer.applyEpisode(episode);
  const rel = Object.values(reducer.snapshot().relationships)[0];
  assert.deepEqual(rel.romantic_history, ['kiss']);
  assert.equal(rel.formal_status, undefined);
  assert.equal(reducer.snapshot().characters[peter].identity, undefined);
});

test('Phase 7: refusal boundary and salient no-kiss negative are preserved precisely', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('Attempted kiss refused.');
  episode.relationshipChanges.push({ participants: [peter, felicia], dimension: 'boundary', operation: 'set', value: { status: 'active', content: 'No kiss; Peter pulled away' }, evidence: 'explicit' });
  episode.salientNegatives.push({ proposition: 'Peter and Felicia kissed', reason: 'Attempted kiss was explicitly refused', evidence: 'explicit' });
  reducer.applyEpisode(episode, { segmentId: 'S1' });
  const state = reducer.snapshot();
  assert.equal(Object.values(state.relationships)[0].boundary.content, 'No kiss; Peter pulled away');
  assert.equal(state.salientNegatives[0].proposition, 'Peter and Felicia kissed');
});

test('Phase 7: arbitrary non-event and vague theme are not persisted', () => {
  const reducer = new NarrativeStateReducer();
  const episode = emptyEpisodeSummary('Nothing specific.');
  episode.salientNegatives.push({ proposition: 'A dragon did not appear', reason: 'No dragon mentioned', evidence: 'explicit' });
  episode.threads.push({ key: 'love', description: 'love', transition: 'open', evidence: 'weak_inference' });
  reducer.applyEpisode(episode);
  assert.equal(reducer.snapshot().salientNegatives.length, 0);
  assert.equal(Object.keys(reducer.snapshot().threads).length, 0);
});

test('Phase 7: commitment and concrete thread lifecycles transition without silence reset', () => {
  const reducer = new NarrativeStateReducer();
  const made = emptyEpisodeSummary('Promise and thread.');
  made.commitments.push({ id: 'honesty', actor: peter, toward: mj, content: 'No lies by omission', transition: 'made', evidence: 'explicit' });
  made.threads.push({ key: 'missing_ledger', description: 'Find the missing ledger copy', transition: 'open', evidence: 'explicit' });
  reducer.applyEpisode(made);
  reducer.applyEpisode(emptyEpisodeSummary('Unrelated scene.'));
  assert.equal(reducer.snapshot().commitments.honesty.status, 'active');
  assert.equal(reducer.snapshot().threads.missing_ledger.status, 'open');
  const broken = emptyEpisodeSummary('Peter hides another message.');
  broken.commitments.push({ id: 'honesty', actor: peter, toward: mj, content: 'No lies by omission', transition: 'broken', evidence: 'explicit' });
  broken.threads.push({ key: 'missing_ledger', description: 'Find the missing ledger copy', transition: 'resolved', evidence: 'explicit' });
  reducer.applyEpisode(broken);
  assert.equal(reducer.snapshot().commitments.honesty.status, 'broken');
  assert.equal(reducer.snapshot().threads.missing_ledger.status, 'resolved');
});

test('Phase 7: upstream card canon remains separate and immutable from learned overlay', () => {
  const card = { [peter]: { occupation: 'photographer' } };
  const reducer = new NarrativeStateReducer({ cardCanon: card });
  const episode = emptyEpisodeSummary('New job.');
  episode.stateChanges.push({ subject: peter, path: 'learnedAttributes.currentJob', operation: 'set', value: 'reporter', evidence: 'explicit', persistence: 'durable' });
  reducer.applyEpisode(episode);
  const state = reducer.snapshot();
  assert.equal(state.upstreamCanon[peter].occupation, 'photographer');
  assert.equal(state.characters[peter].learnedAttributes.currentJob, 'reporter');
  assert.deepEqual(card, { [peter]: { occupation: 'photographer' } });
});

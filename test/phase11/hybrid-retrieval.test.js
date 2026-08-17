import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';
import { LexicalIndex } from '../../src/retrieval/lexical-index.js';
import { RetrievalQueryBuilder } from '../../src/retrieval/query-builder.js';
import { EmbeddingAdapter, EmbeddingCache } from '../../src/retrieval/embedding-adapter.js';
import { HybridRetriever, retrievalQuality } from '../../src/retrieval/hybrid-retriever.js';

function segment(id, synopsis, extras = {}) {
  return { id, status: 'valid', source: { first: { messageIndex: extras.firstIndex ?? 0 }, last: { messageIndex: extras.lastIndex ?? 1 } }, summary: { synopsis, events: [], observations: [], threads: extras.threads ?? [], commitments: extras.commitments ?? [], registerObservations: [], entities: extras.entities ?? [] } };
}

test('Phase 11: deterministic query builder extracts stable terms and semantic keys', async () => {
  const builder = new RetrievalQueryBuilder();
  const input = { currentUserMessage: 'What happened to the hidden phone?', rawTail: [{ mes: 'Peter looks worried.' }], entities: [{ id: 'peter', canonicalName: 'Peter Parker' }], activeThreads: [{ key: 'missing-phone' }], activeCommitments: [{ id: 'tell-truth' }], activeRegisters: ['tournament'] };
  assert.deepEqual(await builder.build(input), await builder.build(input));
  const query = await builder.build(input);
  assert.ok(query.terms.includes('phone'));
  assert.deepEqual(query.entityIds, ['peter']);
  assert.deepEqual(query.threads, ['missing-phone']);
});

test('Phase 11: closed commitments do not become retrieval query keys', async () => {
  const builder = new RetrievalQueryBuilder();
  const query = await builder.build({
    activeCommitments: [
      { id: 'active-promise', status: 'active' },
      { id: 'retired-promise', status: 'obsolete' },
      { id: 'kept-promise', status: 'kept' },
    ],
  });
  assert.deepEqual(query.commitments, ['active-promise']);
  assert.equal(query.terms.includes('retired-promise'), false);
});

test('Phase 11: model-assisted builder is opt-in and falls back deterministically', async () => {
  let calls = 0;
  const builder = new RetrievalQueryBuilder({ assistant: async () => { calls += 1; throw new Error('offline'); } });
  const plain = await builder.build({ currentUserMessage: 'the old promise' });
  assert.equal(calls, 0);
  const assisted = await builder.build({ currentUserMessage: 'the old promise' }, { allowModelAssistance: true });
  assert.equal(calls, 1);
  assert.deepEqual(assisted, plain);
});

test('Phase 11: missing embedding backend falls back cleanly to lexical callback retrieval', async () => {
  const index = new LexicalIndex();
  const old = segment('old-phone', 'Mara concealed the phone beneath the loose floorboard.');
  const noise = segment('noise', 'Rain fell over the empty market.');
  index.rebuild([old, noise]);
  const retriever = new HybridRetriever({ lexicalIndex: index, embeddingAdapter: new EmbeddingAdapter() });
  const result = await retriever.retrieve({ terms: ['hidden', 'phone', 'floorboard'] }, [{ id: old.id, text: old.summary.synopsis }, { id: noise.id, text: noise.summary.synopsis }]);
  assert.equal(result[0].id, 'old-phone');
  assert.equal(result[0].mode, 'lexical');
  assert.ok(result[0].reasons.some(reason => reason.kind === 'lexical'));
});

test('Phase 11: hybrid semantic retrieval finds an old paraphrased callback', async () => {
  const vectors = new Map([['where is the device', [1, 0]], ['Mara concealed the phone beneath the loose floorboard.', [0.98, 0.02]], ['Rain fell over the empty market.', [0, 1]]]);
  const backend = async text => vectors.get(text) ?? [0, 0];
  const index = new LexicalIndex();
  const items = [segment('callback', 'Mara concealed the phone beneath the loose floorboard.'), segment('noise', 'Rain fell over the empty market.')];
  index.rebuild(items);
  const retriever = new HybridRetriever({ lexicalIndex: index, embeddingAdapter: new EmbeddingAdapter({ backend }) });
  const result = await retriever.retrieve('where is the device', items.map(item => ({ id: item.id, fingerprint: item.id, text: item.summary.synopsis })), { semanticWeight: 1 });
  assert.equal(result[0].id, 'callback');
  assert.equal(result[0].mode, 'hybrid');
});

test('Phase 11: exact thread match outranks irrelevant high semantic similarity', async () => {
  const backend = async text => text.includes('irrelevant') ? [1, 0] : text === 'where next' ? [1, 0] : [0.2, 0.8];
  const index = new LexicalIndex();
  const relevant = segment('relevant', 'The quiet train rendezvous remains pending.', { threads: [{ key: 'escape-route', description: 'Meet at the train' }] });
  const irrelevant = segment('irrelevant', 'An irrelevant but semantically similar escape discussion.');
  index.rebuild([relevant, irrelevant]);
  const retriever = new HybridRetriever({ lexicalIndex: index, embeddingAdapter: new EmbeddingAdapter({ backend }) });
  const result = await retriever.retrieve({ terms: ['where', 'next'], threads: ['escape-route'] }, [relevant, irrelevant].map(item => ({ id: item.id, fingerprint: item.id, text: item.summary.synopsis, document: index.serialize().find(doc => doc.id === item.id) })));
  assert.equal(result[0].id, 'relevant');
  assert.ok(result[0].reasons.some(reason => reason.kind === 'thread-match'));
});

test('Phase 11: artifact cache varies by model/config while stable artifacts reuse vectors', async () => {
  let calls = 0;
  const backend = async () => { calls += 1; return [1, 0]; };
  const cache = new EmbeddingCache();
  const one = new EmbeddingAdapter({ backend, cache, model: 'm1', config: { dimensions: 2 } });
  await one.embedArtifact({ fingerprint: 'a1', text: 'secret' });
  await one.embedArtifact({ fingerprint: 'a1', text: 'secret' });
  assert.equal(calls, 1);
  await new EmbeddingAdapter({ backend, cache, model: 'm2', config: { dimensions: 2 } }).embedArtifact({ fingerprint: 'a1', text: 'secret' });
  await new EmbeddingAdapter({ backend, cache, model: 'm1', config: { dimensions: 3 } }).embedArtifact({ fingerprint: 'a1', text: 'secret' });
  assert.equal(calls, 3);
});

test('Phase 11: metrics separate embedding requests and retrieval stage counts', async () => {
  const metrics = new MetricsRecorder();
  const index = new LexicalIndex();
  const item = segment('promise', 'Ana promised to tell the truth at dawn.');
  index.rebuild([item]);
  const retriever = new HybridRetriever({ lexicalIndex: index, embeddingAdapter: new EmbeddingAdapter({ backend: async () => [1, 0], metrics }), metrics });
  await retriever.retrieve('truth promise', [{ id: item.id, fingerprint: item.id, text: item.summary.synopsis }]);
  const events = metrics.snapshot();
  assert.equal(events.filter(event => event.operation === 'embedding_request').length, 2);
  assert.equal(events.filter(event => event.operation === 'memory_extraction').length, 0);
  const retrieval = events.find(event => event.operation === 'retrieval');
  assert.equal(retrieval.corpusCount, 1);
  assert.equal(retrieval.selectedCount, 1);
  assert.ok(Number.isFinite(retrieval.lexicalLatencyMs));
});

test('Phase 11: fixed callback fixtures report Recall@K, Precision@K, and MRR', () => {
  const report = retrievalQuality([
    { relevantIds: ['phone'], resultIds: ['phone', 'rain'] },
    { relevantIds: ['promise'], resultIds: ['noise', 'promise'] },
  ], { k: 2 });
  assert.deepEqual(report, { k: 2, fixtureCount: 2, recallAtK: 1, precisionAtK: 0.5, mrr: 0.75 });
});

test('Phase 18: BM25 normalizes document length instead of rewarding unrelated verbosity', () => {
  const index = new LexicalIndex();
  const concise = segment('concise', 'The copper signal identifies the rendezvous.');
  const verbose = segment('verbose', `The copper signal appears. ${Array.from({ length: 120 }, (_, index) => `unrelated${index}`).join(' ')}`);
  index.rebuild([verbose, concise]);
  const result = index.search({ terms: ['copper', 'signal'] });
  assert.deepEqual(result.map(item => item.id), ['concise', 'verbose']);
  assert.equal(result[0].scoring, 'bm25');
});

test('Phase 18: bounded recency reranks equal evidence but cannot beat an exact old thread callback', async () => {
  const index = new LexicalIndex();
  const oldExact = segment('old-exact', 'The escape discussion remains unresolved.', { lastIndex: 20, threads: [{ key: 'escape-route', description: 'Meet beneath the old station clock' }] });
  const recent = segment('recent', 'The escape discussion happened casually today.', { lastIndex: 1_000 });
  index.rebuild([oldExact, recent]);
  const documents = new Map(index.serialize().map(document => [document.id, document]));
  const retriever = new HybridRetriever({ lexicalIndex: index });
  const result = await retriever.retrieve({ terms: ['escape', 'discussion'], threads: ['escape-route'] }, [oldExact, recent].map(item => ({ id: item.id, text: item.summary.synopsis, document: documents.get(item.id) })), { recencyWeight: 0.5 });
  assert.equal(result[0].id, 'old-exact');
  assert.ok(result.find(item => item.id === 'recent').reasons.some(reason => reason.kind === 'bounded-recency'));
});

test('Phase 18: active speaker and participant references produce explicit retrieval reasons', async () => {
  const index = new LexicalIndex();
  const participantMemory = segment('jean-memory', 'The meeting ended quietly.', { lastIndex: 10, entities: [{ mention: 'Jean Grey', proposedEntityId: 'jean' }] });
  const recentNoise = segment('recent-meeting', 'The meeting ended quietly.', { lastIndex: 500 });
  index.rebuild([participantMemory, recentNoise]);
  const documents = new Map(index.serialize().map(document => [document.id, document]));
  const retriever = new HybridRetriever({ lexicalIndex: index });
  const result = await retriever.retrieve({ terms: ['meeting'], entityIds: ['jean'], participantEntityIds: ['jean'], activeSpeakerEntityId: 'jean' }, [participantMemory, recentNoise].map(item => ({ id: item.id, text: item.summary.synopsis, document: documents.get(item.id) })));
  assert.equal(result[0].id, 'jean-memory');
  assert.ok(result[0].reasons.some(reason => reason.kind === 'active-speaker-match'));
  assert.ok(result[0].reasons.some(reason => reason.kind === 'active-participant-match'));
});

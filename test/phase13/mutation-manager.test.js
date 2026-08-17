import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';
import { MutationManager, PendingJobGuard, activeInjectableSegments } from '../../src/invalidation/mutation-manager.js';

function segment(id, first, last, status = 'valid', dependencies = []) {
  return { id, status, source: { first: { messageIndex: first }, last: { messageIndex: last }, rangeFingerprint: `${id}-fp` }, summary: { synopsis: id }, dependencyIds: dependencies };
}

test('Phase 13: edit invalidates covering segment, descendants, and dependent indexes lazily', () => {
  const manager = new MutationManager();
  const result = manager.handleEdit([segment('s1', 0, 4), segment('s2', 5, 9), segment('s3', 10, 14, 'valid', ['s2'])], 7);
  assert.equal(result.segments[0].status, 'valid');
  assert.deepEqual(result.segments.slice(1).map(item => item.status), ['stale', 'stale']);
  assert.equal(result.eagerExtractionCalls, 0);
  assert.deepEqual(activeInjectableSegments(result.segments).map(item => item.id), ['s1']);
});

test('Phase 13: deletion closes the source-index gap and marks affected suffix stale', () => {
  const manager = new MutationManager();
  const result = manager.handleDelete([segment('s1', 0, 2), segment('s2', 3, 5), segment('s3', 6, 8)], 4);
  assert.equal(result.replanned, true);
  assert.deepEqual(result.segments.map(item => [item.source.first.messageIndex, item.source.last.messageIndex]), [[0, 2], [3, 4], [5, 7]]);
  assert.deepEqual(result.segments.map(item => item.status), ['valid', 'stale', 'stale']);
});

test('Phase 13: swiped confession disappears and inactive branch memory is never injectable', () => {
  const manager = new MutationManager();
  const confession = segment('confession', 0, 4);
  const result = manager.handleSwipe([confession, segment('after', 5, 8)], { messageIndex: 3, previousFingerprint: 'confession-swipe', activeFingerprint: 'denial-swipe' });
  assert.equal(result.cacheHit, false);
  assert.deepEqual(activeInjectableSegments(result.segments).map(item => item.id), []);
});

test('Phase 13: swiping back reuses exact active-fingerprint cache with zero calls', () => {
  const metrics = new MetricsRecorder();
  const manager = new MutationManager({ metrics });
  const original = [segment('confession', 0, 4), segment('after', 5, 8)];
  manager.storeBranch(3, 'confession-swipe', original);
  const result = manager.handleSwipe([segment('denial', 0, 4)], { messageIndex: 3, previousFingerprint: 'denial-swipe', activeFingerprint: 'confession-swipe' });
  assert.equal(result.cacheHit, true);
  assert.deepEqual(result.segments.map(item => item.id), ['confession', 'after']);
  assert.equal(result.eagerExtractionCalls, 0);
  assert.equal(metrics.snapshot().at(-1).status, 'cache_hit');
});

test('Phase 13: old asynchronous job cannot commit after chat switch or source change', () => {
  const guard = new PendingJobGuard();
  const token = guard.begin({ jobId: 'job-1', chatId: 'chat-a', sourceFingerprint: 'source-a' });
  assert.equal(guard.canCommit(token, { chatId: 'chat-a', sourceFingerprint: 'source-a' }), true);
  assert.equal(guard.canCommit(token, { chatId: 'chat-b', sourceFingerprint: 'source-a' }), false);
  assert.equal(guard.canCommit(token, { chatId: 'chat-a', sourceFingerprint: 'source-b' }), false);
  guard.finish(token);
  assert.equal(guard.canCommit(token, { chatId: 'chat-a', sourceFingerprint: 'source-a' }), false);
});

test('Phase 13: a large old-history edit records bounded traversal and zero eager calls', () => {
  const metrics = new MetricsRecorder();
  const manager = new MutationManager({ metrics });
  const segments = Array.from({ length: 500 }, (_, index) => segment(`s${index}`, index * 2, index * 2 + 1));
  const result = manager.handleEdit(segments, 20);
  assert.equal(result.staleCount, 490);
  assert.equal(result.visitedCount, 500);
  assert.equal(result.eagerExtractionCalls, 0);
  const metric = metrics.snapshot().find(event => event.operation === 'source_invalidation');
  assert.deepEqual([metric.visitedCount, metric.staleCount, metric.eagerExtractionCalls], [500, 490, 0]);
});

test('Phase 13: dependency traversal reaches non-suffix artifacts', () => {
  const manager = new MutationManager();
  const segments = [segment('future-dependent', 0, 0, 'valid', ['changed']), segment('changed', 10, 12)];
  const result = manager.handleEdit(segments, 11);
  assert.equal(result.segments[0].status, 'stale');
  assert.equal(result.dependencyCount, 1);
});

test('Phase 13: prose-only fallback remains inspectable but cannot replace raw source', () => {
  const value = segment('prose', 0, 1);
  value.extraction = { quality: 'prose', replacementEligible: false };
  assert.deepEqual(activeInjectableSegments([value]), []);
});

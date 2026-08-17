import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { LexicalIndex } from '../../src/retrieval/lexical-index.js';
import { SemanticStore } from '../../src/storage/semantic-store.js';
import { RebuildManager, exportDiagnostics, exportSemanticMemory, importSemanticMemory } from '../../src/storage/portability.js';
import { createDashboardModel, createDashboardView, dashboardMarkup, filterTimeline, paginateTimeline, renderTimelineCard } from '../../src/ui/dashboard.js';
import { MetricsRecorder } from '../../src/observability/metrics-recorder.js';

function memoryAdapter(initial = null) {
  let value = structuredClone(initial);
  return { readPortableMemory: async () => structuredClone(value), writePortableMemory: async next => { value = structuredClone(next); }, state: () => structuredClone(value) };
}

function segment(firstIndex = 0, synopsis = 'Episode synopsis') {
  const source = createSourceRange([{ role: 'user', text: `source-${firstIndex}`, swipeId: 0 }], firstIndex);
  return { id: segmentIdFromSource(source.rangeFingerprint), source, dependencyIds: [], sourceTokenCount: 2, summary: emptyEpisodeSummary(synopsis), status: 'valid', createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 1, manuallyEdited: false, pinned: false };
}

test('Phase 14: dashboard exposes every inspector, setting, repair control, and sensitive-preview option', () => {
  const markup = dashboardMarkup();
  for (const id of ['mnemosyne-enabled', 'mnemosyne-inject-managed', 'mnemosyne-timeline', 'mnemosyne-characters', 'mnemosyne-relationships', 'mnemosyne-registers', 'mnemosyne-conflicts', 'mnemosyne-retrieval', 'mnemosyne-prompt-preview', 'mnemosyne-metrics', 'mnemosyne-collapse-sensitive', 'mnemosyne-export-memory', 'mnemosyne-import-memory', 'mnemosyne-rebuild-full', 'mnemosyne-rebuild-indexes', 'mnemosyne-export-diagnostics', 'mnemosyne-backfill-analyze', 'mnemosyne-backfill-start', 'mnemosyne-backfill-pause', 'mnemosyne-backfill-cancel', 'mnemosyne-backfill-export', 'mnemosyne-backfill-status', 'mnemosyne-audit-integrity']) assert.match(markup, new RegExp(id));
  assert.match(markup, /data-setting="autoCompact"/);
  assert.match(markup, /contextBudget|rawTailBudget|segmentTarget|retrievalMode|memoryConnectionProfileId/);
  assert.match(markup, /memoryGroupParticipantNames|mnemosyne-profile-status/);
  assert.match(markup, /mnemosyne-profile-overrides|mnemosyne-profile-save|mnemosyne-profile-clear/);
  assert.match(markup, /mnemosyne-scoped-profile-editor|data-scoped-profile-field|data-profile-scope-action/);
  assert.match(markup, /mnemosyne-section--controls|mnemosyne-section-heading|mnemosyne-action-groups/);
  assert.match(markup, /Context budget|Runtime & provider|Extraction & limits/);
  for (const setting of ['segmentSoftMax', 'segmentHardMax', 'extractionInputBudget', 'extractionMaxOutputTokens', 'rebuildTotalInputBudget', 'preemptiveRatio', 'integrityAuditIntervalMessages', 'contextStateBudget', 'contextRegistersBudget', 'contextChronologicalBudget', 'contextAssociativeBudget', 'extractionStateBudget', 'extractionChronologicalBudget', 'extractionHistoricalBudget', 'extractionRawPreludeBudget', 'memoryExtractionRetries', 'preferFallbackExtraction', 'injectIntoQuietGenerations']) {
    assert.match(markup, new RegExp(`data-setting="${setting}"`));
  }
  assert.match(markup, /memorySessionTokenCap|memoryDailyTokenCap|mnemosyne-token-guard-status/);
  assert.match(markup, /mnemosyne-timeline-search|mnemosyne-timeline-clear/);
  assert.match(markup, /mnemosyne-timeline-bulk|mnemosyne-timeline-selected-count|data-bulk-action="select-page"/);
  assert.doesNotMatch(markup, /memorySessionCreditCap|memoryDailyCreditCap|Session credit cap|Daily credit cap/);
});

test('Phase 14: dashboard repair actions persist through SemanticStore', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const item = segment();
  await store.commitSegment(item);
  const model = createDashboardModel({ settings: {}, store, metrics: new MetricsRecorder() });
  await model.edit(item.id, 'User-corrected truth');
  await model.pin(item.id, true);
  assert.equal(store.get(item.id).summary.synopsis, 'User-corrected truth');
  assert.equal(store.get(item.id).manuallyEdited, true);
  assert.equal(store.get(item.id).pinned, true);
});

test('Phase 14: commitment retirement is a confirmed semantic action, not a generic record edit', async () => {
  const adapter = memoryAdapter();
  const store = new SemanticStore({ adapter, chatId: 'chat-a' });
  const item = segment(6);
  item.summary.commitments.push({ id: 'promise', actor: 'ent_0000000000000001', content: 'Return the borrowed key', transition: 'active', evidence: 'explicit' });
  await store.commitSegment(item);
  const model = createDashboardModel({ settings: {}, store, metrics: new MetricsRecorder() });
  const card = renderTimelineCard(store.get(item.id));
  assert.match(card, /data-action="retire-commitment"/);
  assert.match(card, /Retire commitment/);
  assert.doesNotMatch(card, /data-action="edit-record"/);
  await model.retireCommitment(item.id, 0);
  assert.equal(store.get(item.id).summary.commitments[0].transition, 'obsolete');
  assert.doesNotMatch(renderTimelineCard(store.get(item.id)), /data-action="retire-commitment"/);
});

test('Phase 14: semantic export/import round-trips and rejects schema/chat mismatch', async () => {
  const store = new SemanticStore({ adapter: memoryAdapter(), chatId: 'chat-a' });
  await store.commitSegment(segment());
  const exported = exportSemanticMemory(store.snapshot());
  assert.deepEqual(importSemanticMemory(exported, { expectedChatId: 'chat-a' }), store.snapshot());
  assert.throws(() => importSemanticMemory(exported, { expectedChatId: 'chat-b' }), /different chat/);
  const wrongSchema = JSON.parse(exported); wrongSchema.schemaVersion = 999;
  assert.throws(() => importSemanticMemory(wrongSchema, { expectedChatId: 'chat-a' }), /Unsupported/);
});

test('Phase 14: dashboard import validates then persists the current-chat envelope', async () => {
  const targetAdapter = memoryAdapter();
  const target = new SemanticStore({ adapter: targetAdapter, chatId: 'chat-a' });
  const source = new SemanticStore({ adapter: memoryAdapter(), chatId: 'chat-a' });
  await source.commitSegment(segment());
  const model = createDashboardModel({ settings: {}, store: target, metrics: new MetricsRecorder(), getChatId: () => 'chat-a' });
  await model.importMemory(exportSemanticMemory(source.snapshot()));
  assert.equal(target.timeline().length, 1);
  assert.equal(target.timeline()[0].summary.synopsis, 'Episode synopsis');
});

test('Phase 14: rebuild preserves manual edits and index-only rebuild avoids extraction', async () => {
  const manual = segment(0, 'Corrected by user'); manual.manuallyEdited = true; manual.manualProvenance = { kind: 'manual' };
  const generated = { ...segment(0, 'Generated replacement'), source: manual.source, id: manual.id };
  let extractionCalls = 0;
  const index = new LexicalIndex();
  const manager = new RebuildManager({ buildSegments: async () => { extractionCalls += 1; return [generated, segment(2, 'New')]; }, lexicalIndex: index });
  const rebuilt = await manager.full([{ mes: 'raw' }], [manual]);
  assert.equal(rebuilt[0].summary.synopsis, 'Corrected by user');
  assert.equal(rebuilt[0].manuallyEdited, true);
  manager.indexesOnly(rebuilt);
  assert.equal(extractionCalls, 1);
  assert.equal(index.size, 2);
});

test('Phase 14: default diagnostic export contains metrics but no narrative text', () => {
  const diagnostics = exportDiagnostics({
    metrics: [{ operation: 'retrieval', count: 2 }],
    telemetry: [{ event: 'memory_attempt_validation_failed', details: { validationErrors: ['events[0].evidence received "private prose"'], content: 'private confession' } }],
    semanticMemory: { segments: [{ summary: { synopsis: 'private confession' } }] },
  });
  const serialized = JSON.stringify(diagnostics);
  assert.match(serialized, /retrieval/);
  assert.match(serialized, /memory_attempt_validation_failed|validationErrors/);
  assert.doesNotMatch(serialized, /private confession|synopsis|semanticMemory|private prose/);
});

test('Phase 14: metrics stay local and model exposes prompt/retrieval diagnostics', () => {
  const originalFetch = globalThis.fetch;
  const metrics = new MetricsRecorder(); metrics.record({ operation: 'context_compile', totalTokens: 12 });
  const model = createDashboardModel({ settings: {}, store: { snapshot: () => ({ segments: [] }) }, metrics, getPromptPreview: () => ({ preview: 'compiled', totalTokens: 12 }), getRetrieval: () => [{ id: 'old', reasons: [{ kind: 'thread-match' }] }] });
  const view = model.snapshot();
  assert.equal(view.prompt.preview, 'compiled');
  assert.equal(view.retrieval[0].reasons[0].kind, 'thread-match');
  assert.equal(view.metrics[0].operation, 'context_compile');
  assert.equal(globalThis.fetch, originalFetch);
});

test('Phase 14: dashboard view derives relationships from valid segment changes', () => {
  const source = segment(4);
  source.summary.relationshipChanges.push({ participants: ['Edward', 'Amélie'], dimension: 'romantic', operation: 'set', value: 'committed', evidence: 'explicit' });
  const view = createDashboardView({ segments: [source], relationships: [], entities: [], registers: [], conflicts: [] });
  assert.equal(view.relationships.length, 1);
  assert.deepEqual(view.relationships[0].participants, ['Edward', 'Amélie']);
  assert.equal(view.relationships[0].provenance.segmentId, source.id);
});

test('Phase 14: timeline pagination is bounded and deterministic', () => {
  const timeline = Array.from({ length: 21 }, (_, index) => ({ id: `segment-${index}` }));
  assert.deepEqual(paginateTimeline(timeline, 0, 10).items.map(item => item.id), ['segment-0', 'segment-1', 'segment-2', 'segment-3', 'segment-4', 'segment-5', 'segment-6', 'segment-7', 'segment-8', 'segment-9']);
  assert.deepEqual(paginateTimeline(timeline, 9, 10), { page: 2, pageCount: 3, items: [{ id: 'segment-20' }] });
  assert.deepEqual(paginateTimeline(timeline, -1, 10), { page: 0, pageCount: 3, items: timeline.slice(0, 10) });
});

test('Phase 14: timeline search filters semantic content without changing the source envelope', () => {
  const segments = [
    { id: 'one', status: 'valid', summary: { synopsis: 'Peter keeps the copper key.', events: [{ description: 'The key changes hands.' }] } },
    { id: 'two', status: 'failed', summary: { synopsis: 'Jean waits at the station.', events: [] } },
  ];
  assert.deepEqual(filterTimeline(segments, 'copper').map(segment => segment.id), ['one']);
  assert.deepEqual(filterTimeline(segments, 'FAILED').map(segment => segment.id), ['two']);
  assert.deepEqual(filterTimeline(segments, '').map(segment => segment.id), ['one', 'two']);
});

test('Phase 14: dashboard markup uses structured containers and keeps synopsis as the only edit surface', () => {
  const markup = dashboardMarkup();
  assert.match(markup, /mnemosyne-expand/);
  assert.match(markup, /mnemosyne-popout-close/);
  assert.match(markup, /mnemosyne-timeline-prev/);
  assert.match(markup, /mnemosyne-timeline-next/);
  assert.match(markup, /mnemosyne-token-preview/);
  assert.doesNotMatch(markup, /<pre id="mnemosyne-characters"/);
  assert.doesNotMatch(markup, /<pre id="mnemosyne-relationships"/);
});

test('Phase 14: timeline cards expose source range badges and selection without semantic edit controls', () => {
  const source = segment(7);
  const view = createDashboardView({ segments: [source], entities: [], registers: [], conflicts: [] });
  assert.equal(view.timeline[0].source.first.messageIndex, 7);
  const markup = dashboardMarkup();
  assert.match(markup, /Select page/);
  assert.match(markup, /Pin selected/);
  assert.match(markup, /Restore selected/);
  assert.deepEqual(view.timeline[0].source.rangeFingerprint, source.source.rangeFingerprint);
  const card = renderTimelineCard(source, { selected: true });
  assert.match(card, /mnemosyne-source-badge/);
  assert.match(card, /integrity tracked|legacy integrity/);
  assert.match(card, /data-action="select"/);
  assert.match(card, /checked/);
  assert.match(card, /Inspect source/);
  assert.match(card, /Jump to chat|data-action="source-focus"/);
  assert.doesNotMatch(card, /raw source/);
  assert.match(renderTimelineCard(source, { sourcePreview: [{ index: 7, role: 'user', name: 'Peter', text: 'raw source' }] }), /Source messages|raw source/);
  assert.doesNotMatch(markup, /data-action="edit-record"/);
});

test('Phase 14: timeline cards expose stale and pending integrity health without changing the envelope', () => {
  const stale = segment(8); stale.status = 'stale';
  const pending = segment(9); pending.status = 'pending';
  assert.match(renderTimelineCard(stale), /integrity stale/);
  assert.match(renderTimelineCard(pending), /integrity pending/);
  assert.doesNotMatch(renderTimelineCard(stale), /Save semantic|data-action="edit-record"/);
});

test('Phase 14: source inspection is read-only and delegated to the active chat adapter', () => {
  const model = createDashboardModel({ settings: {}, store: { snapshot: () => ({ segments: [] }) }, metrics: new MetricsRecorder(), getSourceFor: id => [{ id, index: 2, role: 'assistant', text: 'raw' }], focusSourceRange: (first, last) => first === 2 && last === 3 });
  assert.deepEqual(model.sourceFor('segment-a'), [{ id: 'segment-a', index: 2, role: 'assistant', text: 'raw' }]);
  assert.equal(model.focusSource(2, 3), true);
  assert.equal(model.focusSource(8, 9), false);
});

test('Phase 14: dashboard view carries a sanitized scoped-profile catalog without semantic envelope fields', () => {
  const view = createDashboardView({ segments: [], entities: [], registers: [], conflicts: [] }, { profileCatalog: { identity: { characterId: 'ava' }, profiles: { characters: { ava: { contextBudget: 9000 } } } } });
  assert.equal(view.profileCatalog.identity.characterId, 'ava');
  assert.equal(view.profileCatalog.profiles.characters.ava.contextBudget, 9000);
  assert.equal(view.profileCatalog.profiles.characters.ava.synopsis, undefined);
});

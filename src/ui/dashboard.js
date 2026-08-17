import { exportDiagnostics, exportSemanticMemory, importSemanticMemory } from '../storage/portability.js';
import { MNEMOSYNE_VERSION } from '../core/constants.js';

const TIMELINE_PAGE_SIZE = 10;
const DASHBOARD_STATE = new WeakMap();
const FAMILY_LABELS = Object.freeze({
  events: 'Events',
  observations: 'Observations',
  stateChanges: 'State changes',
  knowledgeChanges: 'Knowledge',
  relationshipChanges: 'Relationships',
  commitments: 'Commitments',
  threads: 'Threads',
  salientNegatives: 'Salient negatives',
  registerObservations: 'Registers',
  interpretations: 'Interpretations',
  temporal: 'Temporal',
  locations: 'Locations',
});
const FAMILY_KEYS = Object.freeze(Object.keys(FAMILY_LABELS));
const FAMILY_FIELDS = Object.freeze({
  events: ['description', 'participants', 'evidence', 'salience', 'domains'],
  observations: ['description', 'subject', 'predicate', 'value', 'evidence', 'persistence', 'salience', 'domains', 'continuityRelevant'],
  stateChanges: ['subject', 'path', 'operation', 'value', 'evidence', 'persistence'],
  knowledgeChanges: ['holder', 'proposition', 'kind', 'operation', 'evidence'],
  relationshipChanges: ['participants', 'dimension', 'operation', 'value', 'evidence'],
  commitments: ['id', 'actor', 'toward', 'content', 'transition', 'evidence'],
  threads: ['key', 'description', 'transition', 'evidence'],
  salientNegatives: ['proposition', 'reason', 'evidence', 'continuityRelevant'],
  registerObservations: ['kind', 'registerKey', 'observationKey', 'eventKey', 'subject', 'value', 'newValue', 'entries', 'values', 'completeness', 'evidence'],
  interpretations: ['description', 'evidence'],
  temporal: ['description', 'kind', 'evidence'],
  locations: ['subject', 'location', 'kind', 'evidence'],
});

function snapshotOf(store) {
  return store?.snapshot?.() ?? { segments: [], entities: [], registers: [], conflicts: [], rebuildSessions: [] };
}

function relationshipInspector(memory) {
  if (Array.isArray(memory.relationships) && memory.relationships.length) return memory.relationships;
  return (memory.segments ?? [])
    .filter(segment => segment.status === 'valid' && segment.summary)
    .flatMap(segment => (segment.summary.relationshipChanges ?? []).map((change, index) => ({
      ...structuredClone(change),
      id: `${segment.id}:relationship:${index}`,
      provenance: { segmentId: segment.id, source: segment.source?.rangeFingerprint ?? null },
    })));
}

export function createDashboardView(memory = {}, { retrieval = [], prompt = null, metrics = [], backfill = { status: 'idle' }, generation = { mode: 'live' }, integrity = { status: 'unknown' }, tokenBudget = {}, profileCatalog = { identity: {}, profiles: {} }, sensitiveCollapsed = true } = {}) {
  const normalized = { ...memory, segments: memory.segments ?? [], entities: memory.entities ?? [], registers: memory.registers ?? [], conflicts: memory.conflicts ?? [] };
  return {
    timeline: normalized.segments,
    characters: normalized.entities,
    relationships: relationshipInspector(normalized),
    registers: normalized.registers,
    conflicts: normalized.conflicts,
    retrieval: retrieval ?? [],
    prompt: prompt ?? null,
    metrics: metrics ?? [],
    backfill: backfill ?? { status: 'idle' },
    generation: generation ?? { mode: 'live' },
    integrity: integrity ?? { status: 'unknown' },
    tokenBudget: tokenBudget ?? {},
    profileCatalog: profileCatalog ?? { identity: {}, profiles: {} },
    rebuildSessions: normalized.rebuildSessions ?? [],
    sensitiveCollapsed,
  };
}

export function paginateTimeline(timeline = [], page = 0, pageSize = TIMELINE_PAGE_SIZE) {
  const size = Math.max(1, Number(pageSize) || TIMELINE_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(timeline.length / size));
  const currentPage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
  return { page: currentPage, pageCount, items: timeline.slice(currentPage * size, (currentPage + 1) * size) };
}

export function filterTimeline(timeline = [], query = '') {
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  if (!needle) return [...timeline];
  return timeline.filter(segment => {
    const summary = segment?.summary ?? {};
    const source = segment?.source ?? {};
    const searchable = [
      segment?.id, segment?.status, segment?.extraction?.quality, source?.rangeFingerprint,
      summary?.synopsis,
      ...Object.values(summary).flatMap(value => Array.isArray(value) ? value : [value]),
    ].map(value => typeof value === 'string' ? value : displayValue(value)).join(' ').toLocaleLowerCase();
    return searchable.includes(needle);
  });
}

export function createDashboardModel({ settings, store, metrics, getTelemetry = () => [], getPromptPreview = () => null, getRetrieval = () => [], getGenerationStatus = () => ({ mode: settings.memoryGenerationMode ?? 'live' }), getIntegrityStatus = () => ({ status: 'unknown' }), auditIntegrity = null, getTokenStatus = () => ({}), getProfileStatus = () => getGenerationStatus().profile ?? {}, getProfileCatalog = () => ({ identity: {}, profiles: {} }), getEnabled = () => settings.enabled !== false, getChatId = () => store.snapshot().chatId, refreshMemory = null, rebuildFull = null, rebuildIndexes = null, getBackfillStatus = () => ({ status: 'idle' }), analyzeBackfill = null, runBackfill = null, resumeRebuild = null, pauseBackfill = null, cancelBackfill = null, getRebuildSession = null, exportRebuildSession = null, importRebuildSession = null, replayRebuild = null, analyzeSegmentRegeneration = null, regenerateSegment = null, retireCommitment = null, promoteRebuild = null, deleteRebuildSession = null, getSourceFor = null, setChatProfileOverrides = null, setScopedProfile = null, deleteScopedProfile = null, focusSourceRange = null }) {
  return {
    settings,
    isEnabled: () => Boolean(getEnabled()),
    snapshot() {
      return createDashboardView(snapshotOf(store), {
        retrieval: getRetrieval(),
        prompt: getPromptPreview(),
        metrics: metrics?.snapshot?.() ?? [],
        backfill: getBackfillStatus(),
        generation: getGenerationStatus(),
        integrity: getIntegrityStatus(),
        tokenBudget: getTokenStatus(),
        profileCatalog: getProfileCatalog(),
        sensitiveCollapsed: settings.collapseSensitivePreviews !== false,
      });
    },
    async edit(id, synopsis) { return store.editSynopsis(id, synopsis); },
    async pin(id, value) { return store.setPinned(id, value); },
    async exclude(id, value) { return store.setExcluded(id, value); },
    async retireCommitment(segmentId, commitmentIndexOrId) {
      if (retireCommitment) return retireCommitment(segmentId, commitmentIndexOrId);
      if (store.retireCommitment) return store.retireCommitment(segmentId, commitmentIndexOrId);
      throw new Error('Commitment retirement is unavailable');
    },
    profileStatus: () => getProfileStatus(),
    setChatProfileOverrides: patch => setChatProfileOverrides?.(patch),
    profileCatalog: () => getProfileCatalog(),
    setScopedProfile: (scope, id, patch) => setScopedProfile?.(scope, id, patch),
    deleteScopedProfile: (scope, id) => deleteScopedProfile?.(scope, id),
    sourceFor: id => getSourceFor?.(id) ?? store.sourceFor?.(id) ?? [],
    focusSource: (firstIndex, lastIndex = firstIndex) => focusSourceRange?.(firstIndex, lastIndex) ?? false,
    analyzeRegeneration: id => analyzeSegmentRegeneration?.(id),
    async regenerate(id, options) {
      if (regenerateSegment) return regenerateSegment(id, options);
      throw new Error('Targeted blue/green regeneration is unavailable');
    },
    exportMemory() { return exportSemanticMemory(store.snapshot()); },
    async importMemory(serialized, chatId = getChatId()) {
      const envelope = importSemanticMemory(serialized, { expectedChatId: chatId });
      await store.replaceEnvelope(envelope);
      return envelope;
    },
    rebuildFull: () => rebuildFull?.(),
    rebuildIndexes: () => rebuildIndexes?.(),
    refreshMemory: () => refreshMemory?.(),
    auditIntegrity: () => auditIntegrity?.(),
    importRebuildSession: serialized => importRebuildSession?.(serialized),
    replayRebuild: (id, options) => replayRebuild?.(id, options),
    analyzeBackfill: options => analyzeBackfill?.(options),
    runBackfill: options => runBackfill?.(options),
    resumeRebuild: (id, options) => resumeRebuild?.(id, options),
    pauseBackfill: () => pauseBackfill?.(),
    cancelBackfill: () => cancelBackfill?.(),
    exportBackfillReport() { return JSON.stringify(getBackfillStatus().report ?? {}, null, 2); },
    getRebuildSession: id => getRebuildSession?.(id),
    exportRebuildSession: id => exportRebuildSession?.(id),
    promoteRebuild: id => promoteRebuild?.(id),
    deleteRebuildSession: id => deleteRebuildSession?.(id),
    exportDiagnostics(options = {}) { return exportDiagnostics({ metrics: metrics?.snapshot?.() ?? [], telemetry: getTelemetry?.() ?? [], ...options }); },
  };
}

export function mountDashboard(host, model, { onEnabledChange = null, onSettingsChange = null } = {}) {
  if (!host || typeof document === 'undefined') return null;
  host.innerHTML = dashboardMarkup();
  const state = { timelinePage: 0, timelineQuery: '', revealedSensitive: new Set(), selectedSegments: new Set(), sourcePreviews: new Map(), profileDraftDirty: false, scopedProfileDraftDirty: false, selectedPlanId: null };
  DASHBOARD_STATE.set(host, state);
  const enabled = host.querySelector('#mnemosyne-enabled');
  enabled.checked = model.isEnabled();
  enabled.addEventListener('change', () => {
    onEnabledChange?.(enabled.checked);
  });
  const sensitive = host.querySelector('#mnemosyne-collapse-sensitive');
  sensitive.checked = model.settings.collapseSensitivePreviews !== false;
  sensitive.addEventListener('change', () => {
    model.settings.collapseSensitivePreviews = sensitive.checked;
    state.revealedSensitive.clear();
    onSettingsChange?.();
    renderDashboard(host, model);
  });
  const injectManaged = host.querySelector('#mnemosyne-inject-managed');
  if (injectManaged) {
    injectManaged.checked = model.snapshot().generation?.memoryInjectionEnabled !== false;
    injectManaged.addEventListener('change', () => {
      model.settings.injectManagedMemory = injectManaged.checked;
      onSettingsChange?.();
      renderDashboard(host, model);
    });
  }
  const showRefreshError = (targetHost, error) => {
    const target = targetHost.querySelector('#mnemosyne-backfill-status');
    if (target) target.innerHTML = `<div class="mnemosyne-alert">Memory refresh failed: ${escapeHtml(error?.message ?? String(error))}</div>`;
  };
  host.querySelector('#mnemosyne-refresh').addEventListener('click', async () => {
    try { await model.refreshMemory?.(); renderDashboard(host, model); } catch (error) { showRefreshError(host, error); }
  });
  host.querySelector('#mnemosyne-audit-integrity')?.addEventListener('click', async () => {
    try { await model.auditIntegrity?.(); renderDashboard(host, model); } catch (error) { showRefreshError(host, error); }
  });
  host.querySelector('#mnemosyne-profile-overrides')?.addEventListener('input', () => { state.profileDraftDirty = true; });
  host.querySelector('#mnemosyne-profile-save')?.addEventListener('click', async () => {
    const patch = {};
    for (const input of host.querySelectorAll('#mnemosyne-profile-overrides [data-profile-field]')) {
      const value = String(input.value ?? '').trim();
      if (!value) continue;
      patch[input.dataset.profileField] = input.type === 'number' ? Number(value) : value;
    }
    try {
      await model.setChatProfileOverrides?.(patch);
      state.profileDraftDirty = false;
      renderDashboard(host, model);
    } catch (error) { showRefreshError(host, error); }
  });
  host.querySelector('#mnemosyne-profile-clear')?.addEventListener('click', async () => {
    try {
      await model.setChatProfileOverrides?.({});
      state.profileDraftDirty = false;
      renderDashboard(host, model);
    } catch (error) { showRefreshError(host, error); }
  });
  host.querySelector('#mnemosyne-scoped-profile-editor')?.addEventListener('input', () => { state.scopedProfileDraftDirty = true; });
  host.querySelector('#mnemosyne-scoped-profile-editor')?.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-profile-scope-action]');
    if (!button) return;
    const card = button.closest('[data-profile-scope]');
    const scope = card?.dataset.profileScope;
    const id = card?.dataset.profileId;
    if (!scope || !id) return;
    try {
      if (button.dataset.profileScopeAction === 'delete') {
        if (globalThis.confirm?.(`Delete the ${scope.slice(0, -1)} profile for ${id}?` ) === false) return;
        await model.deleteScopedProfile?.(scope, id);
      } else if (button.dataset.profileScopeAction === 'save') {
        const patch = {};
        for (const input of card.querySelectorAll('[data-scoped-profile-field]')) {
          const value = String(input.value ?? '').trim();
          if (!value) continue;
          patch[input.dataset.scopedProfileField] = input.type === 'number' ? Number(value) : value;
        }
        await model.setScopedProfile?.(scope, id, patch);
      }
      state.scopedProfileDraftDirty = false;
      renderDashboard(host, model);
    } catch (error) { showRefreshError(host, error); }
  });
  host.querySelector('#mnemosyne-expand').addEventListener('click', () => {
    host.classList.add('mnemosyne-popout-open');
    renderDashboard(host, model);
  });
  host.querySelector('#mnemosyne-popout-close').addEventListener('click', () => {
    host.classList.remove('mnemosyne-popout-open');
    renderDashboard(host, model);
  });
  host.querySelector('#mnemosyne-export-memory').addEventListener('click', () => downloadText('mnemosyne-memory.json', model.exportMemory()));
  host.querySelector('#mnemosyne-export-diagnostics').addEventListener('click', () => downloadText('mnemosyne-diagnostics.json', JSON.stringify(model.exportDiagnostics(), null, 2)));
  host.querySelector('#mnemosyne-import-memory').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    await model.importMemory(await file.text());
    renderDashboard(host, model);
  });
  host.querySelector('#mnemosyne-import-rebuild')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await model.importRebuildSession?.(await file.text());
      renderDashboard(host, model);
    } catch (error) {
      showBackfillError(error);
    } finally {
      event.target.value = '';
    }
  });
  host.querySelector('#mnemosyne-rebuild-indexes').addEventListener('click', async () => { await model.rebuildIndexes(); renderDashboard(host, model); });
  host.querySelector('#mnemosyne-rebuild-full').addEventListener('click', async () => {
    try {
      const analysis = await model.analyzeBackfill({ rebuild: true });
      const tokenRange = analysis.projection?.inputTokens && analysis.projection?.outputTokens
        ? `, approximately ${formatCount(analysis.projection.inputTokens.minimum)}-${formatCount(analysis.projection.inputTokens.maximum)} input tokens plus ${formatCount(analysis.projection.outputTokens.minimum)}-${formatCount(analysis.projection.outputTokens.target)} output tokens`
        : '';
      const plan = analysis.optimization;
      const chosenPlan = plan?.alternatives?.find(candidate => candidate.id === state.selectedPlanId) ?? plan?.recommended;
      const planText = chosenPlan ? ` Selected ${chosenPlan.objective ?? 'balanced'} plan: ${chosenPlan.segments?.length ?? analysis.plannedSegmentCount} segments, ${formatCount(chosenPlan.metrics?.expectedTotalTokens ?? 0)} expected tokens, ${formatCount(chosenPlan.metrics?.maxInputTokens ?? 0)} max input; ${plan.calibration?.confidence ?? 'low'} calibration.` : '';
      const approved = globalThis.confirm?.(`Full rebuild will process ${analysis.plannedSegmentCount} segments using ${analysis.estimatedMinimumRequests}-${analysis.estimatedMaximumRequests} model requests${tokenRange}.${planText} The active green baseline remains in use until atomic promotion. Continue?`);
      if (approved === false) { renderDashboard(host, model); return; }
      const planCandidateId = state.selectedPlanId ?? analysis.recommendedPlanId;
      void model.runBackfill({ rebuild: true, analysisFingerprint: analysis.analysisFingerprint, planCandidateId }).then(() => renderDashboard(host, model)).catch(showBackfillError);
      renderDashboard(host, model);
    } catch (error) { showBackfillError(error); }
  });
  const showBackfillError = error => {
    const target = host.querySelector('#mnemosyne-backfill-status');
    if (target) target.innerHTML = `<div class="mnemosyne-alert">${escapeHtml(error?.message ?? String(error))}</div>`;
  };
  host.querySelector('#mnemosyne-backfill-analyze').addEventListener('click', async () => {
    try { await model.analyzeBackfill(); renderDashboard(host, model); } catch (error) { showBackfillError(error); }
  });
  host.querySelector('#mnemosyne-backfill-status')?.addEventListener('change', event => {
    if (event.target?.id === 'mnemosyne-adaptive-plan-select') state.selectedPlanId = event.target.value || null;
  });
  host.querySelector('#mnemosyne-backfill-start').addEventListener('click', async () => {
    try {
      const analysis = await model.analyzeBackfill();
      const tokenRange = analysis.projection?.inputTokens && analysis.projection?.outputTokens
        ? `, approximately ${formatCount(analysis.projection.inputTokens.minimum)}-${formatCount(analysis.projection.inputTokens.maximum)} input tokens plus ${formatCount(analysis.projection.outputTokens.minimum)}-${formatCount(analysis.projection.outputTokens.target)} output tokens remaining`
        : '';
      const retry = analysis.compactRetry
        ? ` A ${analysis.compactRetry.stage === 'minimal_fallback' ? 'minimal tagged fallback' : 'compact structured'} retry is pending for ${analysis.compactRetry.segmentId}; it allows up to ${formatCount(analysis.compactRetry.maxOutputTokens)} output tokens and is projected at up to ${Math.round(analysis.compactRetry.credits.noCache)} credits without cache${analysis.compactRetry.cacheObserved ? ` (${Math.round(analysis.compactRetry.credits.withPreviousCache)} with the previously reported cache)` : ''}.`
        : '';
      const plan = analysis.optimization;
      const chosenPlan = plan?.alternatives?.find(candidate => candidate.id === state.selectedPlanId) ?? plan?.recommended;
      const planText = chosenPlan ? ` Selected ${chosenPlan.objective ?? 'balanced'} plan has ${chosenPlan.segments?.length ?? analysis.plannedSegmentCount} segments, ${formatCount(chosenPlan.metrics?.expectedTotalTokens ?? 0)} expected tokens, and ${formatCount(chosenPlan.metrics?.maxInputTokens ?? 0)} max input.` : '';
      const approved = globalThis.confirm?.(`Start/resume ${analysis.plannedSegmentCount} remaining historical segments (${analysis.preservedValidCount ?? 0} preserved green)? Expected ${analysis.estimatedMinimumRequests} model requests${tokenRange}.${planText}${retry} Active green memory remains unchanged until complete.`);
      if (approved === false) { renderDashboard(host, model); return; }
      const planCandidateId = state.selectedPlanId ?? analysis.recommendedPlanId;
      void model.runBackfill({ analysisFingerprint: analysis.analysisFingerprint, planCandidateId }).then(() => renderDashboard(host, model)).catch(showBackfillError);
      renderDashboard(host, model);
    } catch (error) { showBackfillError(error); }
  });
  host.querySelector('#mnemosyne-backfill-pause').addEventListener('click', () => { model.pauseBackfill(); renderDashboard(host, model); });
  host.querySelector('#mnemosyne-backfill-cancel').addEventListener('click', () => { model.cancelBackfill(); renderDashboard(host, model); });
  host.querySelector('#mnemosyne-backfill-export').addEventListener('click', () => downloadText('mnemosyne-backfill-report.json', model.exportBackfillReport()));
  host.querySelector('#mnemosyne-timeline-prev').addEventListener('click', () => { state.timelinePage -= 1; renderDashboard(host, model); });
  host.querySelector('#mnemosyne-timeline-next').addEventListener('click', () => { state.timelinePage += 1; renderDashboard(host, model); });
  host.querySelector('#mnemosyne-timeline-search')?.addEventListener('input', event => {
    state.timelineQuery = event.target.value;
    state.timelinePage = 0;
    renderDashboard(host, model);
  });
  host.querySelector('#mnemosyne-timeline-clear')?.addEventListener('click', () => {
    state.timelineQuery = '';
    state.timelinePage = 0;
    const search = host.querySelector('#mnemosyne-timeline-search');
    if (search) search.value = '';
    renderDashboard(host, model);
  });
  host.querySelector('#mnemosyne-timeline-bulk')?.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-bulk-action]');
    if (!button) return;
    const action = button.dataset.bulkAction;
    if (action === 'clear') {
      state.selectedSegments.clear();
      renderDashboard(host, model);
      return;
    }
    if (action === 'select-page') {
      const current = model.snapshot();
      const filtered = filterTimeline(current.timeline, state.timelineQuery);
      const page = paginateTimeline(filtered, state.timelinePage, TIMELINE_PAGE_SIZE);
      for (const segment of page.items) state.selectedSegments.add(segment.id);
      renderDashboard(host, model);
      return;
    }
    const ids = [...state.selectedSegments];
    if (!ids.length) return;
    try {
      for (const id of ids) {
        if (action === 'pin') await model.pin(id, true);
        if (action === 'unpin') await model.pin(id, false);
        if (action === 'exclude') await model.exclude(id, true);
        if (action === 'restore') await model.exclude(id, false);
      }
      state.selectedSegments.clear();
      renderDashboard(host, model);
    } catch (error) {
      showBackfillError(error);
    }
  });
  host.querySelector('#mnemosyne-rebuild-sessions').addEventListener('click', async event => {
    const button = event.target.closest?.('[data-rebuild-action]');
    const sessionId = button?.closest?.('[data-rebuild-id]')?.dataset.rebuildId;
    if (!button || !sessionId) return;
    if (button.dataset.rebuildAction === 'export') downloadText(`mnemosyne-${sessionId}.json`, await model.exportRebuildSession(sessionId));
    if (button.dataset.rebuildAction === 'replay' && globalThis.confirm?.(`Replay recorded outputs for ${sessionId}? No provider request or new tokens will be used.`) !== false) await model.replayRebuild?.(sessionId);
    if (button.dataset.rebuildAction === 'resume' && globalThis.confirm?.(`Resume targeted rebuild session ${sessionId}? This retries only its pending range; the active green baseline remains unchanged.`) !== false) await model.resumeRebuild?.(sessionId, { autoPromote: false });
    if (button.dataset.rebuildAction === 'promote' && globalThis.confirm?.(`Promote rebuild session ${sessionId} as active memory? The current green baseline will be replaced atomically.`) !== false) await model.promoteRebuild(sessionId);
    if (button.dataset.rebuildAction === 'delete' && globalThis.confirm?.(`Permanently delete rebuild session ${sessionId} and its raw attempts?`) !== false) await model.deleteRebuildSession(sessionId);
    renderDashboard(host, model);
  });
  for (const input of host.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    if (model.settings[key] !== undefined && model.settings[key] !== null) {
      if (input.type === 'checkbox') input.checked = Boolean(model.settings[key]);
      else input.value = String(model.settings[key]);
    }
    input.addEventListener('change', () => {
      model.settings[key] = input.type === 'checkbox'
        ? input.checked
        : input.type === 'number' ? Number(input.value) : input.value;
      onSettingsChange?.();
      renderDashboard(host, model);
    });
  }
  host.querySelector('#mnemosyne-timeline').addEventListener('click', async event => {
    const button = event.target.closest?.('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'select') {
      const id = button.closest('[data-segment-id]')?.dataset.segmentId;
      if (id) {
        if (button.checked) state.selectedSegments.add(id); else state.selectedSegments.delete(id);
        renderDashboard(host, model);
      }
      return;
    }
    if (button.dataset.action === 'sensitive-toggle') {
      const id = button.closest('[data-segment-id]')?.dataset.segmentId;
      if (id) {
        if (state.revealedSensitive.has(id)) state.revealedSensitive.delete(id); else state.revealedSensitive.add(id);
        renderDashboard(host, model);
      }
      return;
    }
    const item = button.closest('[data-segment-id]');
    const id = item?.dataset.segmentId;
    if (!id) return;
    if (button.dataset.action === 'source-toggle') {
      try {
        if (state.sourcePreviews.has(id)) state.sourcePreviews.delete(id);
        else state.sourcePreviews.set(id, await model.sourceFor(id));
        renderDashboard(host, model);
      } catch (error) {
        showBackfillError(error);
      }
      return;
    }
    if (button.dataset.action === 'source-focus') {
      const focused = await model.focusSource(Number(item.dataset.sourceFirst), Number(item.dataset.sourceLast));
      if (!focused) showBackfillError(new Error('The source message is not currently rendered in the SillyTavern chat.'));
      return;
    }
    if (button.dataset.action === 'retire-commitment') {
      const commitmentIndex = Number(button.dataset.commitmentIndex);
      const label = button.dataset.commitmentLabel || 'this commitment';
      const approved = globalThis.confirm?.(`Retire ${label}? It will stop being injected into future prompts. The raw chat, original extraction output and attempt history will be preserved.`);
      if (approved !== false) await model.retireCommitment(id, commitmentIndex);
      renderDashboard(host, model);
      return;
    }
    if (button.dataset.action === 'edit') await model.edit(id, item.querySelector('textarea').value);
    if (button.dataset.action === 'pin') await model.pin(id, button.dataset.value !== 'true');
    if (button.dataset.action === 'exclude') await model.exclude(id, button.dataset.value !== 'true');
    if (button.dataset.action === 'regenerate') {
      const analysis = await model.analyzeRegeneration(id);
      const tokens = analysis?.projection?.inputTokens && analysis?.projection?.outputTokens
        ? ` Estimated usage: ${formatCount(analysis.projection.inputTokens.minimum)}-${formatCount(analysis.projection.inputTokens.maximum)} input tokens plus ${formatCount(analysis.projection.outputTokens.minimum)}-${formatCount(analysis.projection.outputTokens.target)} output tokens.`
        : '';
      const approved = globalThis.confirm?.(`Regenerate only messages ${analysis?.firstIndex ?? '?'}-${analysis?.lastIndex ?? '?'} in ${analysis?.estimatedRequests ?? 0} request(s)? The current green candidate remains active until promotion.${tokens}`);
      if (approved !== false) await model.regenerate(id, { autoPromote: false });
    }
    renderDashboard(host, model);
  });
  renderDashboard(host, model);
  const refreshTimer = setInterval(() => { if (model.snapshot().backfill?.status === 'running') renderDashboard(host, model); }, 500);
  return { refresh: () => renderDashboard(host, model), dispose: () => { clearInterval(refreshTimer); DASHBOARD_STATE.delete(host); host.replaceChildren(); } };
}

export function renderDashboard(host, model) {
  if (!host || !model) return;
  const view = model.snapshot();
  const enabled = host.querySelector('#mnemosyne-enabled');
  if (enabled) enabled.checked = model.isEnabled();
  const injectManaged = host.querySelector('#mnemosyne-inject-managed');
  if (injectManaged) injectManaged.checked = view.generation?.memoryInjectionEnabled !== false;
  const state = DASHBOARD_STATE.get(host) ?? { timelinePage: 0, timelineQuery: '', revealedSensitive: new Set(), selectedSegments: new Set(), sourcePreviews: new Map(), profileDraftDirty: false, scopedProfileDraftDirty: false, selectedPlanId: null };
  DASHBOARD_STATE.set(host, state);
  const currentIds = new Set(view.timeline.map(segment => segment.id));
  for (const id of state.selectedSegments) if (!currentIds.has(id)) state.selectedSegments.delete(id);
  for (const id of state.sourcePreviews.keys()) if (!currentIds.has(id)) state.sourcePreviews.delete(id);
  const filteredTimeline = filterTimeline(view.timeline, state.timelineQuery);
  const page = paginateTimeline(filteredTimeline, state.timelinePage, TIMELINE_PAGE_SIZE);
  state.timelinePage = page.page;
  const search = host.querySelector('#mnemosyne-timeline-search');
  if (search && search.value !== state.timelineQuery) search.value = state.timelineQuery;
  const sensitiveCollapsed = model.settings.collapseSensitivePreviews !== false;
  const availablePlans = view.backfill?.analysis?.optimization?.alternatives ?? [];
  if (availablePlans.length && !availablePlans.some(plan => plan.id === state.selectedPlanId)) state.selectedPlanId = view.backfill.analysis.optimization.recommendedPlanId ?? availablePlans.find(plan => plan.objective === 'balanced')?.id ?? availablePlans[0].id;
  const timeline = page.items.map(segment => renderTimelineCard(segment, { sensitiveCollapsed, revealed: state.revealedSensitive.has(segment.id), selected: state.selectedSegments.has(segment.id), sourcePreview: state.sourcePreviews.get(segment.id) ?? null })).join('') || emptyState('No segments yet.');
  const timelineTarget = host.querySelector('#mnemosyne-timeline');
  if (timelineTarget) timelineTarget.innerHTML = timeline;
  const pageTarget = host.querySelector('#mnemosyne-timeline-page');
  if (pageTarget) pageTarget.textContent = filteredTimeline.length ? `Page ${page.page + 1} of ${page.pageCount} · ${filteredTimeline.length}${state.timelineQuery ? ` matching / ${view.timeline.length}` : ''} segments` : (state.timelineQuery ? 'No matching segments' : 'No segments');
  const previous = host.querySelector('#mnemosyne-timeline-prev');
  const next = host.querySelector('#mnemosyne-timeline-next');
  if (previous) previous.disabled = state.timelinePage === 0;
  if (next) next.disabled = state.timelinePage >= page.pageCount - 1;
  const selectedCount = host.querySelector('#mnemosyne-timeline-selected-count');
  if (selectedCount) selectedCount.textContent = `${state.selectedSegments.size} selected`;
  for (const button of host.querySelectorAll('#mnemosyne-timeline-bulk [data-bulk-action]')) {
    button.disabled = !state.selectedSegments.size && !['clear', 'select-page'].includes(button.dataset.bulkAction);
  }
  setInnerHtml(host, '#mnemosyne-characters', renderEntities(view.characters));
  setInnerHtml(host, '#mnemosyne-relationships', renderRelationships(view.relationships));
  setInnerHtml(host, '#mnemosyne-registers', renderRegisters(view.registers));
  setInnerHtml(host, '#mnemosyne-conflicts', renderConflicts(view.conflicts));
  setInnerHtml(host, '#mnemosyne-retrieval', renderRetrieval(view.retrieval));
  setInnerHtml(host, '#mnemosyne-prompt-preview', renderPrompt(view.prompt));
  const tokenTarget = host.querySelector('#mnemosyne-token-preview');
  if (tokenTarget) tokenTarget.innerHTML = renderTokenSummary(view.prompt);
  setInnerHtml(host, '#mnemosyne-metrics', renderMetrics(view.metrics));
  setInnerHtml(host, '#mnemosyne-generation-status', renderGenerationStatus(view.generation));
  const profile = view.generation.profile ?? {};
  setInnerHtml(host, '#mnemosyne-profile-status', renderProfileStatus(profile));
  applyProfileOverrideInputs(host, profile, state.profileDraftDirty);
  setInnerHtml(host, '#mnemosyne-scoped-profile-editor', renderScopedProfileEditor(view.profileCatalog, state.scopedProfileDraftDirty));
  setInnerHtml(host, '#mnemosyne-token-guard-status', renderTokenGuardStatus(view.tokenBudget));
  setInnerHtml(host, '#mnemosyne-integrity-status', renderIntegrityStatus(view.integrity));
  setInnerHtml(host, '#mnemosyne-backfill-status', renderBackfill(view.backfill, sensitiveCollapsed, state));
  setInnerHtml(host, '#mnemosyne-rebuild-sessions', renderRebuildSessions(view.rebuildSessions, view.timeline.length, sensitiveCollapsed));
  const backfillStatus = view.backfill?.status ?? 'idle';
  const backfillAnalyze = host.querySelector('#mnemosyne-backfill-analyze');
  const backfillStart = host.querySelector('#mnemosyne-backfill-start');
  const backfillPause = host.querySelector('#mnemosyne-backfill-pause');
  const backfillCancel = host.querySelector('#mnemosyne-backfill-cancel');
  if (backfillAnalyze) backfillAnalyze.disabled = backfillStatus === 'running';
  if (backfillStart) backfillStart.disabled = backfillStatus === 'running';
  if (backfillPause) backfillPause.disabled = backfillStatus !== 'running';
  if (backfillCancel) backfillCancel.disabled = !['running', 'paused'].includes(backfillStatus);
}

export function renderTimelineCard(segment, { sensitiveCollapsed = true, revealed = false, selected = false, sourcePreview = null } = {}) {
  const summary = segment.summary ?? {};
  const sensitive = isSensitiveSummary(summary);
  const hidden = sensitive && sensitiveCollapsed && !revealed;
  const synopsis = summary.synopsis ?? `[${segment.status ?? 'unknown'}]`;
  const source = segment.source ?? {};
  const first = source.first?.messageIndex ?? segment.firstIndex ?? '?';
  const last = source.last?.messageIndex ?? segment.lastIndex ?? '?';
  const fingerprint = source.rangeFingerprint ? source.rangeFingerprint.slice(0, 14) : 'no fingerprint';
  const bundleCount = source.turnBundles?.length ?? 0;
  const startedAt = source.first?.timestamp ?? source.first?.createdAt ?? segment.createdAt;
  const endedAt = source.last?.timestamp ?? source.last?.createdAt ?? segment.updatedAt ?? segment.createdAt;
  const counts = FAMILY_KEYS.map(key => [key, Array.isArray(summary[key]) ? summary[key].length : 0]).filter(([, count]) => count > 0);
  const preview = hidden ? '<div class="mnemosyne-sensitive-preview">Sensitive preview collapsed. Use “Show preview” or disable the global collapse option.</div>' : `<textarea aria-label="Synopsis">${escapeHtml(synopsis)}</textarea>`;
  const details = hidden ? '<div class="mnemosyne-sensitive-preview">Semantic details collapsed. Reveal the preview to inspect sensitive records.</div>' : FAMILY_KEYS.map(key => renderFamilyDetails(summary, key, segment)).filter(Boolean).join('');
  const sourceDetails = Array.isArray(sourcePreview) ? renderSourcePreview(sourcePreview) : '';
  return `<article class="mnemosyne-card mnemosyne-segment-card${selected ? ' mnemosyne-segment-selected' : ''}" data-segment-id="${escapeHtml(segment.id)}" data-source-first="${escapeHtml(first)}" data-source-last="${escapeHtml(last)}">
    <div class="mnemosyne-card-header"><div><label class="mnemosyne-select-segment"><input type="checkbox" data-action="select" aria-label="Select messages ${escapeHtml(first)}–${escapeHtml(last)}"${selected ? ' checked' : ''}><span><strong>Messages ${escapeHtml(first)}–${escapeHtml(last)}</strong></span></label><span class="mnemosyne-source-badge" title="Source message range ${escapeHtml(first)}–${escapeHtml(last)}">Source ${escapeHtml(first)}–${escapeHtml(last)}</span><span class="mnemosyne-muted"> · ${escapeHtml(fingerprint)}</span></div><div class="mnemosyne-badges">${badge(segment.status ?? 'unknown', statusClass(segment.status))}${integrityBadge(segment)}${badge(segment.extraction?.quality ?? 'unclassified')}${segment.pinned ? badge('pinned', 'accent') : ''}${segment.status === 'excluded' ? badge('excluded', 'warning') : ''}</div></div>
    <div class="mnemosyne-card-meta"><span>${Number(segment.sourceTokenCount ?? 0).toLocaleString()} source tokens</span><span>${formatTimestampRange(startedAt, endedAt)}</span><span>${segment.extraction?.replacementEligible === false ? 'raw-only' : 'injection eligible'}</span><span>${counts.length ? counts.map(([key, count]) => `${escapeHtml(FAMILY_LABELS[key])}: ${count}`).join(' · ') : 'No semantic records'}</span></div>
    ${hidden ? preview : `<label class="mnemosyne-field-label">Synopsis${segment.manuallyEdited ? ' · manually edited' : ''}</label>${preview}`}
    ${hidden ? `<div class="mnemosyne-actions"><button class="menu_button" data-action="sensitive-toggle">Show preview</button></div>` : ''}
    <details class="mnemosyne-semantic-details"${hidden ? ' aria-disabled="true"' : ''}><summary>Semantic details (${counts.reduce((sum, [, count]) => sum + count, 0)} records)</summary>${details || emptyState('No semantic records in this segment.')}</details>
    <div class="mnemosyne-card-meta"><span>${bundleCount ? `${bundleCount} integrity bundle${bundleCount === 1 ? '' : 's'}` : 'legacy range integrity'}</span></div>
    ${sourceDetails ? `<details class="mnemosyne-source-preview" open><summary>Source messages</summary>${sourceDetails}</details>` : ''}
    <div class="mnemosyne-actions"><button data-action="source-toggle">${sourceDetails ? 'Hide source' : 'Inspect source'}</button><button data-action="source-focus">Jump to chat</button><button data-action="edit" ${hidden ? 'disabled' : ''}>Save synopsis</button><button data-action="pin" data-value="${Boolean(segment.pinned)}">${segment.pinned ? 'Unpin' : 'Pin'}</button><button data-action="exclude" data-value="${segment.status === 'excluded'}">${segment.status === 'excluded' ? 'Restore' : 'Exclude'}</button><button data-action="regenerate" ${segment.manuallyEdited || !['valid', 'failed', 'pending'].includes(segment.status) ? 'disabled' : ''}>${segment.status === 'valid' ? 'Regenerate' : 'Retry extraction'}</button></div>
  </article>`;
}

function renderSourcePreview(messages = []) {
  if (!messages.length) return emptyState('No source messages in this range.');
  return `<ol class="mnemosyne-source-list">${messages.map(message => `<li><div class="mnemosyne-card-meta"><span>${escapeHtml(message.role ?? 'unknown')}</span>${message.name ? `<span>${escapeHtml(message.name)}</span>` : ''}${Number.isInteger(message.index) ? `<span>message ${message.index}</span>` : ''}</div><div class="mnemosyne-source-text">${escapeHtml(message.text ?? message.mes ?? '')}</div></li>`).join('')}</ol>`;
}

function renderFamilyDetails(summary, family, segment = null) {
  const values = Array.isArray(summary[family]) ? summary[family] : [];
  if (!values.length) return '';
  const items = values.map((value, index) => `<li class="mnemosyne-record">${renderRecord(value, FAMILY_FIELDS[family] ?? Object.keys(value))}${family === 'commitments' ? renderCommitmentAction(value, index, segment) : ''}${segment ? `<span class="mnemosyne-record-provenance">Source: ${escapeHtml(segment.id)} · ${escapeHtml(segment.source?.rangeFingerprint?.slice(0, 14) ?? 'fingerprint unavailable')}</span>` : ''}</li>`).join('');
  return `<details class="mnemosyne-family"><summary>${escapeHtml(FAMILY_LABELS[family])} (${values.length})</summary><ul class="mnemosyne-record-list">${items}</ul></details>`;
}

function renderCommitmentAction(commitment, index, segment) {
  if (!segment || !['made', 'active', 'unknown'].includes(commitment?.transition)) return '';
  const label = [commitment.actor, commitment.content].filter(Boolean).join(' — ') || `commitment ${index + 1}`;
  return `<div class="mnemosyne-record-actions"><button type="button" class="mnemosyne-commitment-retire" data-action="retire-commitment" data-commitment-index="${index}" data-commitment-label="${escapeHtml(label)}" title="Retire this commitment from future injected state">Retire commitment</button></div>`;
}

function renderRecord(record, fields = []) {
  const keys = fields.filter(key => Object.hasOwn(record ?? {}, key) && record[key] !== undefined && record[key] !== null && record[key] !== '');
  return keys.length ? keys.map(key => `<div class="mnemosyne-record-field"><span class="mnemosyne-record-key">${escapeHtml(labelFor(key))}</span><span>${escapeHtml(displayValue(record[key]))}</span></div>`).join('') : '<span class="mnemosyne-muted">No displayable fields</span>';
}

function renderEntities(entities) {
  if (!entities.length) return emptyState('No characters materialized.');
  return `<div class="mnemosyne-card-grid">${entities.map(entity => `<article class="mnemosyne-card"><div class="mnemosyne-card-header"><strong>${escapeHtml(entity.canonicalName ?? entity.name ?? 'Unnamed entity')}</strong>${badge(entity.kind ?? 'character')}</div><div class="mnemosyne-card-meta"><span>${escapeHtml(entity.id ?? '')}</span><span>${entity.provenance?.length ?? 0} source links</span></div>${entity.aliases?.length ? `<div class="mnemosyne-chip-list">${entity.aliases.map(alias => `<span class="mnemosyne-chip">${escapeHtml(alias.value ?? alias)}</span>`).join('')}</div>` : '<span class="mnemosyne-muted">No aliases</span>'}<details><summary>Provenance</summary>${renderProvenance(entity.provenance)}</details></article>`).join('')}</div>`;
}

function renderRelationships(relationships) {
  if (!relationships.length) return emptyState('No relationship changes materialized.');
  return `<div class="mnemosyne-card-grid">${relationships.map(item => `<article class="mnemosyne-card"><div class="mnemosyne-card-header"><strong>${escapeHtml((item.participants ?? []).join(' ↔ ') || 'Relationship')}</strong>${badge(item.dimension ?? 'unknown')}${badge(item.operation ?? 'change')}</div>${renderRecord(item, ['value', 'evidence'])}${renderProvenance(item.provenance ? [item.provenance] : [])}</article>`).join('')}</div>`;
}

function renderRegisters(registers) {
  if (!registers.length) return emptyState('No registers materialized.');
  return `<div class="mnemosyne-card-grid">${registers.map(register => `<article class="mnemosyne-card"><div class="mnemosyne-card-header"><strong>${escapeHtml(register.key ?? 'Unnamed register')}</strong>${badge(register.lifecycle ?? register.status ?? 'active')}</div><div class="mnemosyne-card-meta"><span>Policy: ${escapeHtml(register.injectionPolicy ?? 'relevant')}</span><span>${register.observations?.length ?? 0} observations</span></div>${register.observations?.length ? `<details><summary>Observations</summary><ul class="mnemosyne-record-list">${register.observations.map(item => `<li class="mnemosyne-record">${renderRecord(item, ['kind', 'observationKey', 'eventKey', 'subject', 'value', 'newValue', 'evidence', 'completeness'])}</li>`).join('')}</ul></details>` : ''}</article>`).join('')}</div>`;
}

function renderConflicts(conflicts) {
  if (!conflicts.length) return emptyState('No conflicts.');
  return `<div class="mnemosyne-card-grid">${conflicts.map(conflict => `<article class="mnemosyne-card"><div class="mnemosyne-card-header"><strong>${escapeHtml(conflict.key ?? conflict.path ?? 'Conflict')}</strong>${badge(conflict.status ?? 'unresolved', 'warning')}</div>${renderRecord(conflict, Object.keys(conflict).filter(key => !['key', 'path', 'status'].includes(key)))}</article>`).join('')}</div>`;
}

function renderRetrieval(retrieval) {
  if (!retrieval.length) return emptyState('No retrieval explanations yet.');
  return `<div class="mnemosyne-card-grid">${retrieval.map(item => `<article class="mnemosyne-card"><div class="mnemosyne-card-header"><strong>${escapeHtml(item.id ?? 'Memory')}</strong>${badge(item.mode ?? 'lexical')}${badge(Number(item.score ?? 0).toFixed(2), 'accent')}</div>${item.reasons?.length ? `<ul class="mnemosyne-reason-list">${item.reasons.map(reason => `<li><strong>${escapeHtml(reason.kind ?? 'match')}</strong>${reason.matches?.length ? `: ${escapeHtml(reason.matches.join(', '))}` : reason.score !== undefined ? `: ${escapeHtml(Number(reason.score).toFixed(2))}` : ''}</li>`).join('')}</ul>` : '<span class="mnemosyne-muted">No reason details</span>'}</article>`).join('')}</div>`;
}

function renderPrompt(prompt) {
  if (!prompt) return emptyState('No compiled prompt yet.');
  const audit = prompt.finalAudit ?? {};
  const auditLabel = audit.status === 'verified' ? 'Final prompt verified' : audit.status === 'mismatch' ? 'Final prompt mismatch' : audit.status === 'missing' ? 'Memory missing from final prompt' : 'Final prompt not observed yet';
  const observedPublic = audit.observedPublicExtensionTokens !== null && audit.observedPublicExtensionTokens !== undefined
    ? `<span>Matched public extensions: ${formatCount(audit.observedPublicExtensionTokens)} tokens (${formatCount(audit.observedPublicExtensionEntryCount)} entries)</span>`
    : '';
  const observedTokens = audit.observedContentTokens !== null && audit.observedContentTokens !== undefined
    ? `<span>Observed content: ${formatCount(audit.observedContentTokens)} tokens</span><span>Mnemosyne: ${formatCount(audit.observedMemoryContentTokens)} tokens</span><span>Other content: ${formatCount(audit.observedExternalContentTokens)} tokens</span>${observedPublic}<span>Tokenizer: ${escapeHtml(audit.tokenSource ?? 'unknown')}</span>`
    : '';
  return `<div class="mnemosyne-card-meta"><span>Position: ${prompt.injection?.position === 1 ? 'in-chat boundary' : escapeHtml(prompt.injection?.position ?? 'unknown')}</span><span>Depth: ${escapeHtml(prompt.injection?.depth ?? 'unknown')}</span><span>Role: ${prompt.injection?.role === 0 ? 'system' : escapeHtml(prompt.injection?.role ?? 'unknown')}</span><span>World Info scan: ${prompt.injection?.scan ? 'yes' : 'no'}</span></div><div class="mnemosyne-status-line ${['mismatch', 'missing'].includes(audit.status) ? 'mnemosyne-alert' : ''}"><strong>${escapeHtml(auditLabel)}</strong></div><div class="mnemosyne-card-meta"><span>Occurrences: ${formatCount(audit.occurrenceCount)}</span><span>Observed role: ${escapeHtml(audit.observedRole ?? 'unknown')}</span><span>Messages after: ${formatCount(audit.observedMessagesAfter)}</span>${observedTokens}</div><details class="mnemosyne-prompt-details"><summary>Compiled context preview</summary><pre>${escapeHtml(prompt.preview ?? '')}</pre></details><div class="mnemosyne-card-meta"><span>Selected: ${prompt.selectedIds?.length ?? 0} memories</span><span>Deduplicated: ${prompt.dropped?.deduplicated ?? 0}</span><span>Budget dropped: ${prompt.dropped?.budget ?? 0}</span><span>Invalid: ${prompt.dropped?.invalid ?? 0}</span></div>`;
}

function renderTokenSummary(prompt) {
  if (!prompt) return emptyState('No compiled prompt yet.');
  const total = Number(prompt.totalTokens) || 0;
  const hardTotal = Number(prompt.budgets?.hardTotal) || 0;
  const totalRatio = hardTotal ? Math.min(100, (total / hardTotal) * 100) : 0;
  const regions = Object.entries(prompt.regionTokens ?? {}).map(([key, value]) => {
    const budget = prompt.budgets?.[key] ?? 0;
    const ratio = budget ? Math.min(100, (Number(value) / budget) * 100) : 0;
    return `<div class="mnemosyne-token-row"><div><span>${escapeHtml(labelFor(key))}</span><span>${Number(value).toLocaleString()} / ${Number(budget).toLocaleString()}</span></div><div class="mnemosyne-token-bar"><span style="width:${ratio}%"></span></div></div>`;
  }).join('');
  const external = prompt.externalPromptBudget ?? {};
  const observedExternalValue = prompt.finalAudit?.observedExternalContentTokens;
  const observedExternal = observedExternalValue !== null && observedExternalValue !== undefined && Number.isFinite(Number(observedExternalValue))
    ? `<span>Observed final external content: ${formatCount(observedExternalValue)} tokens</span>`
    : '';
  const breakdownLabel = external.exactFinalPromptItemization
    ? 'Exact public pre-generation breakdown'
    : external.publicBreakdown?.available
      ? 'Public breakdown available; completeness not proven'
      : 'Final card/lorebook itemization unavailable pre-generation';
  const breakdownEntries = Array.isArray(external.entries)
    ? external.entries.filter(entry => entry.source === 'st_public_breakdown')
    : [];
  const breakdownDetails = breakdownEntries.length
    ? `<details><summary>Public prompt regions</summary><ul class="mnemosyne-record-list">${breakdownEntries.map(entry => `<li><strong>${escapeHtml(entry.label ?? entry.key)}</strong> · ${formatCount(entry.tokens)} tokens${entry.category ? ` · ${escapeHtml(entry.category)}` : ''}</li>`).join('')}</ul></details>`
    : '';
  const externalSummary = external.registryAvailable || external.configuredReserve || external.publicBreakdown?.available
    ? `<div class="mnemosyne-card-meta"><span>Measured public extensions: ${formatCount(external.measuredTokens)} tokens (${formatCount(external.measuredEntryCount)} entries)</span><span>Reserve applied: ${formatCount(prompt.contextReserveTokens)}</span><span>Coverage: ${escapeHtml(external.coverage ?? 'unknown')}</span><span>${escapeHtml(breakdownLabel)}</span>${observedExternal}</div>${breakdownDetails}`
    : observedExternal ? `<div class="mnemosyne-card-meta">${observedExternal}</div>` : '';
  return `<div class="mnemosyne-token-total"><strong>${total.toLocaleString()} / ${hardTotal.toLocaleString()} managed tokens</strong><span>${Math.round(Number(prompt.budgetUtilization ?? (hardTotal ? total / hardTotal : 0)) * 100)}% utilized</span></div><div class="mnemosyne-card-meta"><span>Prompt maximum: ${formatCount(prompt.maximumPromptTokens)}</span><span>Reserved outside Mnemosyne: ${formatCount(prompt.contextReserveTokens)}</span><span>Budget source: ${escapeHtml(prompt.budgetSource ?? 'compiler-only')}</span></div>${externalSummary}<div class="mnemosyne-progress" aria-label="Total token utilization"><span style="width:${totalRatio}%"></span></div>${regions}`;
}

function renderMetrics(metrics) {
  if (!metrics.length) return emptyState('No local metrics yet.');
  const counts = new Map();
  for (const metric of metrics) counts.set(metric.operation, (counts.get(metric.operation) ?? 0) + 1);
  return `<div class="mnemosyne-metric-summary">${[...counts].map(([operation, count]) => `<span class="mnemosyne-chip">${escapeHtml(operation)}: ${count}</span>`).join('')}</div><details><summary>Raw local metrics</summary><pre>${escapeHtml(JSON.stringify(metrics, null, 2))}</pre></details>`;
}

function renderGenerationStatus(generation = {}) {
  const mode = generation.mode ?? 'live';
  const offline = mode !== 'live';
  const label = mode === 'replay' ? 'Replay — 0 provider requests / 0 new tokens' : mode === 'offline' ? 'Offline — 0 requests / 0 new tokens (new ranges stay raw)' : 'Live provider mode';
  const operation = generation.operation && generation.operation !== 'idle' ? `<span>Operation: ${escapeHtml(labelFor(generation.operation))}</span>` : '';
  const segment = Number.isInteger(generation.currentSegmentOrdinal) && generation.totalSegments
    ? `<span>Queue: ${generation.currentSegmentOrdinal} / ${generation.totalSegments}</span>`
    : generation.totalSegments ? `<span>Queue: ${generation.totalSegments} planned</span>` : '';
  const started = generation.requestStartedAt ? `<span>Started: ${escapeHtml(formatTimestamp(generation.requestStartedAt))}</span>` : '';
  const group = generation.groupParticipants?.available?.length
    ? `<span>Group participants: ${escapeHtml((generation.groupParticipants.selected ?? []).join(', ') || 'none selected')} (${generation.groupParticipants.selected?.length ?? 0}/${generation.groupParticipants.available.length})</span>`
    : '';
  const injection = generation.memoryInjectionEnabled === false
    ? '<span>Managed summaries: not injected (raw context only)</span>'
    : '<span>Managed summaries: eligible for injection</span>';
  const singleFlight = generation.memoryOperationBusy
    ? `<span>Memory queue: ${escapeHtml(labelFor(generation.memoryOperationKind ?? generation.operation ?? 'busy'))} (single flight)</span>`
    : '';
  const detail = offline
    ? `<span>Provider requests: 0</span><span>Available segments: ${generation.availableSegmentCount ?? 0}</span><span>Missing segments: ${generation.missingSegmentCount ?? 0}</span>`
    : '<span>New memory calls may use the configured provider.</span>';
  return `<div class="mnemosyne-status-line ${offline ? 'mnemosyne-offline-status' : ''}"><strong>${escapeHtml(label)}</strong>${generation.lastError ? ` · ${escapeHtml(generation.lastError)}` : ''}</div><div class="mnemosyne-card-meta">${operation}${segment}${started}${group}${singleFlight}${injection}${detail}</div>`;
}

function renderProfileStatus(profile = {}) {
  const identity = profile.identity ?? {};
  const applied = profile.appliedScopes ?? [];
  const sources = Object.entries(profile.sources ?? {});
  if (!sources.length) return emptyState('No profile resolution yet.');
  const counts = new Map();
  for (const [, source] of sources) counts.set(source, (counts.get(source) ?? 0) + 1);
  const values = Object.entries(profile.values ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const valueList = values.length
    ? `<details><summary>Resolved values (${values.length})</summary><ul class="mnemosyne-profile-values">${values.map(([key, value]) => `<li><strong>${escapeHtml(labelFor(key))}</strong>: ${escapeHtml(displayValue(value))} <span class="mnemosyne-muted">(${escapeHtml(profile.sources?.[key] ?? 'unknown')})</span></li>`).join('')}</ul></details>`
    : '';
  return `<div class="mnemosyne-status-line"><strong>Effective profile</strong><span>${escapeHtml(applied.join(' → ') || 'global default')}</span></div><div class="mnemosyne-card-meta"><span>Chat: ${escapeHtml(identity.chatId ?? 'unknown')}</span><span>Character: ${escapeHtml(identity.characterId ?? 'none')}</span><span>Group: ${escapeHtml(identity.groupId ?? 'none')}</span></div><ul class="mnemosyne-profile-sources">${[...counts].map(([source, count]) => `<li>${escapeHtml(source)}: ${count} setting${count === 1 ? '' : 's'}</li>`).join('')}</ul>${valueList}`;
}

const SCOPED_PROFILE_FIELDS = Object.freeze([
  ['contextBudget', 'Managed context', 'number', '512'],
  ['rawTailBudget', 'Raw foreground', 'number', '256'],
  ['memoryCooldownMs', 'Cooldown (ms)', 'number', '0'],
  ['memoryConnectionProfileId', 'Connection profile', 'text', ''],
]);

function renderScopedProfileCard(scope, id, profile, dirty) {
  const label = scope === 'characters' ? 'Character profile' : 'Group profile';
  const values = profile ?? {};
  const fields = SCOPED_PROFILE_FIELDS.map(([field, labelText, type, min]) => `<label>${labelText}<input data-scoped-profile-field="${field}" type="${type}"${min ? ` min="${min}"` : ''} value="${escapeHtml(values[field] ?? '')}"></label>`).join('');
  return `<article class="mnemosyne-card mnemosyne-scoped-profile-card" data-profile-scope="${scope}" data-profile-id="${escapeHtml(id)}"><div class="mnemosyne-card-header"><strong>${label}</strong>${badge(id, 'accent')}</div><p class="mnemosyne-muted">Only supported runtime settings are stored here; semantic records and prompt/story text are rejected.</p>${fields}<div class="mnemosyne-actions"><button type="button" data-profile-scope-action="save">Save ${scope === 'characters' ? 'character' : 'group'} profile</button><button type="button" data-profile-scope-action="delete">Delete profile</button></div>${dirty ? '<div class="mnemosyne-muted">Unsaved profile edits</div>' : ''}</article>`;
}

function renderScopedProfileEditor(catalog = {}, dirty = false) {
  const identity = catalog.identity ?? {};
  const profiles = catalog.profiles ?? {};
  const cards = [];
  if (identity.characterId) cards.push(renderScopedProfileCard('characters', identity.characterId, profiles.characters?.[identity.characterId], dirty));
  if (identity.groupId) cards.push(renderScopedProfileCard('groups', identity.groupId, profiles.groups?.[identity.groupId], dirty));
  if (!cards.length) return emptyState('No active character or group scope is available.');
  return `<div class="mnemosyne-card-meta"><span>Scoped profiles follow the current SillyTavern identity.</span><span>Changes affect future resolution, not historical memory.</span></div><div class="mnemosyne-card-grid">${cards.join('')}</div>`;
}

function applyProfileOverrideInputs(host, profile, dirty) {
  if (dirty) return;
  const values = profile.values ?? {};
  const sources = profile.sources ?? {};
  for (const input of host.querySelectorAll('#mnemosyne-profile-overrides [data-profile-field]')) {
    const field = input.dataset.profileField;
    input.value = sources[field] === 'chat override' ? String(values[field] ?? '') : '';
  }
}

function renderTokenGuardStatus(status = {}) {
  const sessionCap = Number(status.sessionCap) || 0;
  const dailyCap = Number(status.dailyCap) || 0;
  const sessionSpent = Number(status.sessionSpentTokens) || 0;
  const dailySpent = Number(status.dailySpentTokens) || 0;
  const reserved = Number(status.reservedTokens) || 0;
  const unlimited = sessionCap === 0 && dailyCap === 0;
  const ledgerWarning = dailyCap > 0 && status.ledgerHealthy === false;
  const sessionText = sessionCap > 0 ? `${formatCount(sessionSpent)} / ${formatCount(sessionCap)} session tokens` : `${formatCount(sessionSpent)} session tokens (unlimited)`;
  const dailyText = dailyCap > 0 ? `${formatCount(dailySpent)} / ${formatCount(dailyCap)} daily tokens` : `${formatCount(dailySpent)} daily tokens (unlimited)`;
  return `<div class="mnemosyne-status-line ${ledgerWarning ? 'mnemosyne-alert' : ''}"><strong>${unlimited ? 'Token guard: unlimited' : 'Token guard active'}</strong>${ledgerWarning ? ' · daily ledger unavailable; live memory calls are paused' : ''}</div><div class="mnemosyne-card-meta"><span>${sessionText}</span><span>${dailyText}</span><span>${formatCount(reserved)} reserved in flight</span></div><div class="mnemosyne-muted">Limits count nominal input + output tokens. Before a request, Mnemosyne reserves the rendered input plus its maximum output.</div>`;
}

function renderIntegrityStatus(integrity = {}) {
  const status = integrity.status ?? 'unknown';
  const label = status === 'valid' ? 'Integrity green' : status === 'stale' ? 'Integrity mismatch detected — affected memory is raw-only' : 'Integrity not audited yet';
  return `<div class="mnemosyne-status-line ${status === 'stale' ? 'mnemosyne-alert' : ''}"><strong>${escapeHtml(label)}</strong></div><div class="mnemosyne-card-meta"><span>Checked segments: ${formatCount(integrity.checkedSegments)}</span><span>Stale segments: ${formatCount(integrity.staleSegments)}</span>${Number.isInteger(integrity.firstChangedIndex) ? `<span>First changed message: ${integrity.firstChangedIndex}</span>` : ''}</div>`;
}

function renderBackfill(backfill, sensitiveCollapsed, state = {}) {
  if (!backfill || (backfill.status === 'idle' && !backfill.analysis && !backfill.report)) return `<div class="mnemosyne-status-line">Idle. Analyze the chat to plan a historical rebuild.</div>`;
  const analysis = backfill.analysis;
  const report = backfill.report;
  const latest = report?.outputs?.at(-1);
  const queueHint = backfill.status === 'running'
    ? '<div class="mnemosyne-muted">Single-flight queue active. Pause or cancel takes effect after the current segment; no automatic resume is performed.</div>'
    : backfill.status === 'paused'
      ? '<div class="mnemosyne-muted">Paused at a segment boundary. Start / resume continues from the first pending or failed range.</div>'
      : backfill.status === 'stopped-on-failure'
        ? '<div class="mnemosyne-alert">Suffix blocked after the failed range. Inspect the attempt, then explicitly start / resume.</div>'
        : '';
  const projected = analysis?.projection?.inputTokens && analysis?.projection?.outputTokens
    ? `<div class="mnemosyne-card-meta"><span>Projected input: ${formatCount(analysis.projection.inputTokens.minimum)}–${formatCount(analysis.projection.inputTokens.maximum)} tokens</span><span>Projected output: ${formatCount(analysis.projection.outputTokens.minimum)}–${formatCount(analysis.projection.outputTokens.target)} tokens</span><span>Preserved green: ${analysis.preservedValidCount ?? 0}</span>${analysis.preservedTokenUsage ? `<span>Already spent: ${formatCount(analysis.preservedTokenUsage.nominalInputTokens)} input + ${formatCount(analysis.preservedTokenUsage.outputTokens)} output tokens</span>` : ''}</div>`
    : '';
  const compactRetry = analysis?.compactRetry
    ? `<div class="mnemosyne-muted">${analysis.compactRetry.stage === 'tight_fallback' ? 'Tight fallback' : analysis.compactRetry.stage === 'minimal_fallback' ? 'Minimal tagged fallback' : 'Compact structured'} retry pending for ${escapeHtml(analysis.compactRetry.segmentId)} (${escapeHtml(analysis.compactRetry.protocol ?? 'retry')}): up to ${formatCount(analysis.compactRetry.maxOutputTokens)} output tokens; worst-case ${Math.round(analysis.compactRetry.credits.noCache)} historical credits${analysis.compactRetry.cacheObserved ? `, or ${Math.round(analysis.compactRetry.credits.withPreviousCache)} using the previously observed cache` : ''}. No request is made until Start / resume is confirmed.</div>`
    : '';
  const historicalAudit = analysis?.projection?.credits
    ? `<details><summary>Historical pricing audit (optional)</summary><div class="mnemosyne-card-meta"><span>Projected historical credits: ${Math.round(analysis.projection.credits.minimum)}–${Math.round(analysis.projection.credits.maximum)}</span></div></details>`
    : '';
  const reportUsage = report?.cost ? `<div class="mnemosyne-card-meta"><span>Input ${formatCount(report.cost.nominalInputTokens)} tokens</span><span>Output ${formatCount(report.cost.outputTokens)} tokens</span><span>Requests ${report.cost.measuredAttempts ?? 0}</span><span>Replay attempts ${report.cost.replayAttempts ?? 0}</span></div>` : '';
  const optimization = analysis?.optimization ? renderOptimization(analysis.optimization, state.selectedPlanId) : '';
  return `<div class="mnemosyne-status-line"><strong>${escapeHtml(backfill.status ?? 'unknown')}</strong>${analysis ? ` · ${analysis.plannedSegmentCount ?? 0} planned · ${analysis.estimatedMinimumRequests ?? 0} minimum requests` : ''}</div>${queueHint}${projected}${optimization}${compactRetry}${historicalAudit}${report ? `<div class="mnemosyne-progress"><span style="width:${progressPercent(report.valid, report.processed)}%"></span></div><div class="mnemosyne-card-meta"><span>Processed ${report.processed ?? 0}</span><span>Valid ${report.valid ?? 0}</span><span>Failed attempts ${report.failed ?? 0}</span></div>${reportUsage}` : ''}${latest ? `<details><summary>Latest output</summary>${sensitiveCollapsed && latest.summary ? '<div class="mnemosyne-sensitive-preview">Sensitive preview collapsed.</div>' : renderRecord(latest, ['segmentId', 'status', 'quality', 'failure', 'format'])}</details>` : ''}`;
}

function renderOptimization(optimization = {}, selectedPlanId = null) {
  const plans = optimization.alternatives ?? [];
  if (!plans.length) return '';
  const selected = selectedPlanId ?? optimization.recommendedPlanId ?? optimization.recommended?.id ?? plans.find(plan => plan.objective === 'balanced')?.id ?? plans[0].id;
  const selector = `<label class="mnemosyne-plan-selector"><span>Plan to start<small>Analysis is local; the selected plan is frozen when Start / resume is confirmed.</small></span><select id="mnemosyne-adaptive-plan-select">${plans.map(plan => `<option value="${escapeHtml(plan.id)}"${plan.id === selected ? ' selected' : ''}>${escapeHtml(plan.objective)} · ${formatCount(plan.segments?.length ?? 0)} segments · ${formatCount(Math.round(plan.metrics?.expectedTotalTokens ?? 0))} tokens</option>`).join('')}</select></label>`;
  const cards = plans.map(plan => `<details class="mnemosyne-plan-option"${plan.objective === 'balanced' ? ' open' : ''}><summary>${escapeHtml(plan.objective)} · ${formatCount(plan.segments?.length ?? 0)} segments · ${formatCount(Math.round(plan.metrics?.expectedTotalTokens ?? 0))} expected tokens</summary><div class="mnemosyne-card-meta"><span>Requests ${formatCount(Math.round(plan.metrics?.expectedRequests ?? 0))}</span><span>Max input ${formatCount(plan.metrics?.maxInputTokens ?? 0)} / ceiling ${formatCount(plan.metrics?.safetyCeiling ?? 0)}</span><span>Expected output ${formatCount(Math.round(plan.metrics?.expectedOutputTokens ?? 0))}</span><span>Wall time ${formatCount(Math.round((plan.metrics?.expectedWallTimeMs ?? 0) / 1000))}s</span><span>Bundles max ${formatCount(plan.metrics?.maxBundles ?? Math.max(...(plan.segments ?? []).map(segment => segment.bundleCount ?? 0), 0))}</span><span>Calibration ${escapeHtml(plan.metrics?.calibrationConfidence ?? optimization.calibration?.confidence ?? 'low')}</span></div><div class="mnemosyne-session-plan">${(plan.segments ?? []).map(segment => `<div class="mnemosyne-plan-item"><strong>${escapeHtml(`${segment.firstIndex ?? segment.source?.first?.messageIndex ?? '?'}–${segment.lastIndex ?? segment.source?.last?.messageIndex ?? '?'}`)}</strong> · ${formatCount(segment.bundleCount ?? segment.source?.turnBundles?.length ?? 0)} bundles · ${formatCount(segment.sourceTokenCount ?? 0)} source · projected input ${formatCount(segment.projectedInputTokens ?? 0)}${segment.reused ? ' · reused green' : ''}</div>`).join('')}</div></details>`).join('');
  return `<details class="mnemosyne-optimization"><summary>Adaptive plans · recommended ${escapeHtml(optimization.recommended?.objective ?? 'balanced')} · reused green ${formatCount(optimization.reusedGreenCount ?? 0)}</summary>${selector}${cards}</details>`;
}

function renderRebuildSessions(sessions, activeCount, sensitiveCollapsed) {
  if (!sessions.length) return emptyState('No rebuild sessions.');
  return sessions.map(session => {
    const plan = session.plan ?? [];
    const valid = plan.filter(item => item.status === 'valid').length;
    const failed = plan.filter(item => item.status === 'failed').length;
    const stale = plan.filter(item => item.status === 'stale').length;
    const remaining = plan.length - valid;
    const attempts = session.attempts ?? [];
    const credits = session.report?.cost?.credits ?? attempts.reduce((sum, attempt) => sum + (attempt.credits ?? 0), 0);
    const replayedCredits = session.report?.cost?.replayedCredits ?? attempts.reduce((sum, attempt) => sum + (attempt.replayedCredits ?? 0), 0);
    const usage = session.report?.cost ?? summarizeAttemptUsage(attempts);
    const projection = session.projection ?? session.report?.projection ?? session.analysis?.projection;
    const pricingAudit = `<details><summary>Optional historical pricing audit</summary><div class="mnemosyne-card-meta"><span>Provider/estimated historical credits: ${Number(credits).toFixed(1)}</span><span>Replay historical credits: ${Number(replayedCredits).toFixed(1)}</span><span>Pricing: in ${session.pricing?.input ?? session.pricing?.inputMultiplier ?? '—'} · cache ${session.pricing?.cache ?? session.pricing?.cacheMultiplier ?? '—'} · out ${session.pricing?.output ?? session.pricing?.outputMultiplier ?? '—'}</span>${projection?.credits ? `<span>Projected historical range: ${Math.round(projection.credits.minimum ?? 0)}–${Math.round(projection.credits.maximum ?? 0)}</span>` : ''}</div></details>`;
    const targetedResume = session.mode === 'targeted-regeneration' && ['incomplete', 'planned'].includes(session.status)
      ? '<button data-rebuild-action="resume">Resume targeted retry</button>'
      : '';
    return `<article class="mnemosyne-card mnemosyne-session-card" data-rebuild-id="${escapeHtml(session.id)}"><div class="mnemosyne-card-header"><div><strong>${escapeHtml(session.id)}</strong><div class="mnemosyne-muted">Active baseline: ${activeCount} segments</div></div>${badge(session.status, statusClass(session.status))}</div><div class="mnemosyne-progress"><span style="width:${progressPercent(valid, plan.length)}%"></span></div><div class="mnemosyne-card-meta"><span>Green ${valid}/${plan.length}</span><span>Failed ${failed}</span><span>Stale ${stale}</span><span>Remaining ${remaining}</span><span>Attempts ${attempts.length}</span><span>Reused ${plan.filter(item => item.reused).length}</span></div><div class="mnemosyne-card-meta"><span>Input ${formatCount(usage.nominalInputTokens)} (${formatCount(usage.uncachedInputTokens)} uncached)</span><span>Output ${formatCount(usage.outputTokens)}</span><span>Cache ${formatCount(usage.cachedInputTokens)}</span><span>${usage.measuredAttempts ?? 0} measured / ${usage.estimatedAttempts ?? 0} estimated / ${usage.replayAttempts ?? attempts.filter(attempt => attempt.executionMode === 'replay').length} replay</span></div><div class="mnemosyne-card-meta"><span>Requested model: ${escapeHtml(session.config?.model ?? 'unknown')}</span><span>Effective models: ${escapeHtml([...new Set(attempts.map(attempt => attempt.model).filter(Boolean))].join(', ') || 'not recorded')}</span>${session.optimization?.objective ? `<span>Planner: ${escapeHtml(session.optimization.objective)} (${escapeHtml(session.optimization.calibration?.confidence ?? 'low')} confidence)</span>` : ''}${projection?.inputTokens ? `<span>Projected input remaining: ${formatCount(projection.inputTokens.minimum)}–${formatCount(projection.inputTokens.maximum)} tokens</span>` : ''}${projection?.outputTokens ? `<span>Projected output remaining: ${formatCount(projection.outputTokens.minimum)}–${formatCount(projection.outputTokens.target)} tokens</span>` : ''}</div>${pricingAudit}<details><summary>Plan and attempts</summary><div class="mnemosyne-session-plan">${plan.map(item => renderPlanItem(item, session.segments ?? [], attempts, sensitiveCollapsed)).join('') || emptyState('No planned segments.')}</div></details><div class="mnemosyne-actions"><button data-rebuild-action="export">Export session</button>${targetedResume}${['incomplete', 'planned', 'running'].includes(session.status) ? '<button data-rebuild-action="replay">Replay recorded outputs</button>' : ''}${['complete', 'promoted'].includes(session.status) ? `<button data-rebuild-action="promote">${session.status === 'promoted' ? 'Re-apply promotion' : 'Promote'}</button>` : ''}<button data-rebuild-action="delete">Delete</button></div></article>`;
  }).join('');
}

function renderPlanItem(item, segments, attempts, sensitiveCollapsed) {
  const candidate = segments.find(segment => segment.id === item.segmentId);
  const segmentAttempts = attempts.filter(attempt => attempt.segmentId === item.segmentId);
  const synopsis = candidate?.summary?.synopsis;
  const projection = item.projectedInputTokens ? `<div class="mnemosyne-card-meta"><span>${formatCount(item.bundleCount ?? item.source?.turnBundles?.length ?? 0)} bundles</span><span>projected input ${formatCount(item.projectedInputTokens)}</span><span>output ${formatCount(item.expectedOutputTokens ?? 0)}</span>${item.reused ? '<span>reused green</span>' : ''}</div>` : '';
  return `<div class="mnemosyne-plan-item"><div class="mnemosyne-card-header"><span><strong>${escapeHtml(item.source?.first?.messageIndex ?? '?')}–${escapeHtml(item.source?.last?.messageIndex ?? '?')}</strong> · ${escapeHtml(item.segmentId ?? '')}</span>${badge(item.status ?? 'pending', statusClass(item.status))}</div>${projection}${candidate && synopsis && !(sensitiveCollapsed && isSensitiveSummary(candidate.summary)) ? `<p>${escapeHtml(synopsis)}</p>` : candidate && synopsis ? '<p class="mnemosyne-sensitive-preview">Sensitive candidate collapsed.</p>' : ''}${segmentAttempts.length ? `<details><summary>${segmentAttempts.length} attempt${segmentAttempts.length === 1 ? '' : 's'}</summary><ul class="mnemosyne-attempt-list">${segmentAttempts.map(renderAttempt).join('')}</ul></details>` : '<span class="mnemosyne-muted">No attempts recorded</span>'}</div>`;
}

function renderAttempt(attempt) {
  const usage = attempt.usage ?? {};
  const usageText = `input ${formatCount(usage.nominalInputTokens)} / cache ${formatCount(usage.cachedInputTokens)} / output ${formatCount(usage.outputTokens)} tokens`;
  const error = attempt.failure ? ` · error ${escapeHtml(attempt.failure)}` : '';
  const protocol = attempt.protocol ? ` · protocol ${attempt.protocol}` : '';
  const outputCap = Number.isFinite(attempt.maxOutputTokens) ? ` · max output ${formatCount(attempt.maxOutputTokens)}` : '';
  const diagnostic = attempt.failureDetails?.kind ? ` · diagnostic ${attempt.failureDetails.kind}` : '';
  const providerDetail = attempt.errorDetail?.providerMessage || attempt.errorDetail?.message;
  const providerDetailText = providerDetail ? ` · provider detail ${escapeHtml(providerDetail)}` : '';
  const providerStatus = attempt.errorDetail?.status ? ` · provider status ${escapeHtml(attempt.errorDetail.status)}` : '';
  const execution = attempt.executionMode ?? 'live';
  const pricingAudit = execution === 'replay'
    ? `0 new tokens / ${Number(attempt.replayedCredits ?? 0).toFixed(1)} historical credits`
    : `historical pricing ${Number(attempt.credits ?? 0).toFixed(1)} credits`;
  return `<li><strong>#${escapeHtml(attempt.attempt ?? '?')}</strong> ${escapeHtml(attempt.status ?? 'received')} · ${escapeHtml(execution)} · ${escapeHtml(attempt.mode ?? 'unknown')} · ${escapeHtml(attempt.model ?? 'unknown')} · finish ${escapeHtml(attempt.finishReason ?? 'unknown')} · ${escapeHtml(formatTimestamp(attempt.createdAt) || 'timestamp unavailable')} · ${escapeHtml(usageText)}${outputCap}${escapeHtml(protocol)} · ${escapeHtml(pricingAudit)}${error}${escapeHtml(diagnostic)}${providerStatus}${providerDetailText}${attempt.rawOutputRef ? ` · raw ${escapeHtml(attempt.rawOutputRef)}` : ''}${attempt.requestId ? ` · request ${escapeHtml(attempt.requestId)}` : ''}</li>`;
}

function renderProvenance(provenance = []) {
  if (!provenance.length) return '<span class="mnemosyne-muted">No provenance</span>';
  return `<ul class="mnemosyne-provenance">${provenance.slice(0, 12).map(item => `<li>${escapeHtml(item.segmentId ?? item.sourceFingerprint ?? item.source?.rangeFingerprint ?? 'source')}</li>`).join('')}</ul>`;
}

function emptyState(text) { return `<p class="mnemosyne-muted mnemosyne-empty">${escapeHtml(text)}</p>`; }
function setInnerHtml(host, selector, html) { const target = host.querySelector(selector); if (target) target.innerHTML = html; }
function progressPercent(value, total) { return total > 0 ? Math.round(Math.max(0, Math.min(1, Number(value ?? 0) / total)) * 100) : 0; }
function statusClass(status) { return ['valid', 'complete', 'promoted'].includes(status) ? 'success' : ['failed', 'incomplete', 'stale'].includes(status) ? 'warning' : ''; }
function integrityBadge(segment = {}) {
  if (segment.status === 'stale') return badge('integrity stale', 'warning');
  if (segment.status === 'failed' || segment.status === 'pending') return badge('integrity pending', 'warning');
  if (Array.isArray(segment.source?.turnBundles) && segment.source.turnBundles.length) return badge('integrity tracked', segment.status === 'valid' ? 'success' : '');
  return badge('legacy integrity');
}
function isSensitiveSummary(summary = {}) {
  const domains = (summary.events ?? []).flatMap(item => item.domains ?? []);
  return domains.includes('romantic') || domains.includes('sexual') || (summary.relationshipChanges ?? []).some(item => item.dimension === 'sexual');
}
function labelFor(value) { return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, character => character.toUpperCase()); }
function formatTimestampRange(start, end) {
  const first = formatTimestamp(start);
  const last = formatTimestamp(end);
  if (!first && !last) return 'timestamps unavailable';
  if (!last || first === last) return `recorded ${first}`;
  return `recorded ${first}–${last}`;
}
function formatTimestamp(value) {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}
function summarizeAttemptUsage(attempts = []) {
  const usage = { nominalInputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, measuredAttempts: 0, estimatedAttempts: 0, replayAttempts: 0 };
  for (const attempt of attempts) {
    for (const key of ['nominalInputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'outputTokens']) {
      if (Number.isFinite(attempt.usage?.[key])) usage[key] += Number(attempt.usage[key]);
    }
    if (attempt.usageSource === 'provider') usage.measuredAttempts += 1;
    if (attempt.usageSource === 'estimated') usage.estimatedAttempts += 1;
    if (attempt.usageSource === 'replay' || attempt.executionMode === 'replay') usage.replayAttempts += 1;
  }
  return usage;
}
function formatCount(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—'; }
function displayValue(value) {
  if (Array.isArray(value)) return value.map(item => displayValue(item)).join(', ');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${labelFor(key)}: ${displayValue(item)}`).join('; ');
  return String(value ?? '');
}
function badge(label, kind = '') { return `<span class="mnemosyne-badge ${escapeHtml(kind)}">${escapeHtml(label)}</span>`; }

export function dashboardMarkup() {
  return `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Mnemosyne <span class="mnemosyne-badge">v${MNEMOSYNE_VERSION}</span></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
    <section class="mnemosyne-section mnemosyne-section--controls" aria-labelledby="mnemosyne-controls-title">
      <div class="mnemosyne-section-heading"><div><h3 id="mnemosyne-controls-title">Memory controls</h3><p>Choose what Mnemosyne may inject and how the inspector behaves.</p></div><span class="mnemosyne-section-kicker">Per chat</span></div>
      <div class="mnemosyne-toggle-list">
        <label class="checkbox_label mnemosyne-toggle"><input id="mnemosyne-enabled" type="checkbox"><span>Enable narrative memory</span><small>Maintain a green semantic baseline for this chat.</small></label>
        <label class="checkbox_label mnemosyne-toggle"><input id="mnemosyne-inject-managed" type="checkbox"><span>Inject managed memory</span><small>Include eligible summaries in generation prompts.</small></label>
        <label class="checkbox_label mnemosyne-toggle"><input type="checkbox" data-setting="autoCompact"><span>Compact on chat open</span><small>Run one bounded local check and, when eligible, one compaction; failed or stale ranges still require explicit resume.</small></label>
        <label class="checkbox_label mnemosyne-toggle"><input id="mnemosyne-collapse-sensitive" type="checkbox"><span>Collapse sensitive previews</span><small>Keep romantic/sexual excerpts hidden until revealed.</small></label>
      </div>
      <div class="mnemosyne-toolbar"><button id="mnemosyne-expand" class="menu_button mnemosyne-button-primary">Expand memory</button><button id="mnemosyne-refresh" class="menu_button">Refresh inspectors</button><button id="mnemosyne-audit-integrity" class="menu_button">Audit integrity</button></div>
    </section>

    <section class="mnemosyne-section" aria-labelledby="mnemosyne-context-title">
      <div class="mnemosyne-section-heading"><div><h3 id="mnemosyne-context-title">Context budget</h3><p>These limits shape what is retained before SillyTavern assembles the final prompt.</p></div><span class="mnemosyne-section-kicker">Tokens</span></div>
      <div class="mnemosyne-setting-grid">
        <label class="mnemosyne-setting"><span>Managed context budget<small>Semantic memory ceiling.</small></span><input type="number" min="512" data-setting="contextBudget" value="${12_000}"></label>
        <label class="mnemosyne-setting"><span>Reserved prompt headroom<small>Space kept for card, lorebook and framing.</small></span><input type="number" min="0" data-setting="contextReserveTokens" value="${5_000}"></label>
        <label class="mnemosyne-setting"><span>Raw foreground budget<small>Recent messages kept lossless; a semantic reserve still applies.</small></span><input type="number" min="256" data-setting="rawTailBudget" value="${6_000}"></label>
        <label class="mnemosyne-setting"><span>Segment target<small>Preferred source size for extraction.</small></span><input type="number" min="256" data-setting="segmentTarget" value="${5_000}"></label>
      </div>
    </section>

    <section class="mnemosyne-section" aria-labelledby="mnemosyne-runtime-title">
      <div class="mnemosyne-section-heading"><div><h3 id="mnemosyne-runtime-title">Runtime & provider</h3><p>Control generation mode, retrieval and connection routing.</p></div><span class="mnemosyne-section-kicker">Live / replay / offline</span></div>
      <div class="mnemosyne-setting-grid">
        <label class="mnemosyne-setting"><span>Memory generation mode<small>Live provider, recorded replay or raw-only.</small></span><select data-setting="memoryGenerationMode"><option value="live">Live provider</option><option value="replay">Replay recorded outputs</option><option value="offline">Offline / raw-only</option></select></label>
        <label class="mnemosyne-setting"><span>Retrieval mode<small>How older valid segments are selected.</small></span><select data-setting="retrievalMode"><option value="lexical">Lexical</option><option value="hybrid">Hybrid</option><option value="embedding">Embedding</option></select></label>
        <label class="mnemosyne-setting mnemosyne-setting--wide"><span>Memory connection profile<small>Leave empty to use the current SillyTavern connection.</small></span><input data-setting="memoryConnectionProfileId" placeholder="Default / current connection"></label>
        <label class="mnemosyne-setting mnemosyne-setting--wide"><span>Group participants<small>Optional names, comma-separated. Empty means all active speakers.</small></span><input data-setting="memoryGroupParticipantNames" placeholder="All active speakers"></label>
      </div>
    </section>

    <section class="mnemosyne-section" aria-labelledby="mnemosyne-extraction-title">
      <div class="mnemosyne-section-heading"><div><h3 id="mnemosyne-extraction-title">Extraction & limits</h3><p>Provider request pacing and local token guards. Advanced schema budgets are below.</p></div><span class="mnemosyne-section-kicker">Operational</span></div>
      <div class="mnemosyne-setting-grid">
        <label class="mnemosyne-setting"><span>Request cooldown<small>Milliseconds between memory requests.</small></span><input type="number" min="0" step="250" data-setting="memoryCooldownMs" value="${3_000}"></label>
        <label class="mnemosyne-setting"><span>Extraction temperature<small>Sampling temperature for memory extraction.</small></span><input type="number" min="0" max="2" step="0.05" data-setting="memoryTemperature" value="${0.2}"></label>
        <label class="mnemosyne-setting"><span>Extraction top P<small>Nucleus sampling limit.</small></span><input type="number" min="0" max="1" step="0.05" data-setting="memoryTopP" value="${1}"></label>
        <label class="mnemosyne-setting"><span>Session token cap<small>0 means unlimited.</small></span><input type="number" min="0" step="1000" data-setting="memorySessionTokenCap" value="0"></label>
        <label class="mnemosyne-setting"><span>Daily token cap<small>0 means unlimited.</small></span><input type="number" min="0" step="1000" data-setting="memoryDailyTokenCap" value="0"></label>
      </div>
    </section>

    <details class="mnemosyne-advanced-settings mnemosyne-section"><summary><span><strong>Advanced extraction budgets</strong><small>Segment caps, context family budgets, retries and telemetry.</small></span><span class="mnemosyne-section-kicker">Optional</span></summary>
      <div class="mnemosyne-setting-grid mnemosyne-setting-grid--advanced">
        <label class="mnemosyne-setting"><span>Segment soft max</span><input type="number" min="256" data-setting="segmentSoftMax" value="${7_000}"></label>
        <label class="mnemosyne-setting"><span>Segment hard max</span><input type="number" min="256" data-setting="segmentHardMax" value="${9_000}"></label>
        <label class="mnemosyne-setting"><span>Planner mode<small>Adaptive plans are analyzed locally; legacy freezes the old greedy planner.</small></span><select data-setting="segmentPlannerMode"><option value="adaptive_balanced">Adaptive balanced</option><option value="legacy_greedy">Legacy greedy</option></select></label>
        <label class="mnemosyne-setting"><span>Maximum turn bundles</span><input type="number" min="1" max="5" step="1" data-setting="segmentMaxTurnBundles" value="5"></label>
        <label class="mnemosyne-setting"><span>Input safety ratio</span><input type="number" min="0.1" max="1" step="0.05" data-setting="segmentInputSafetyRatio" value="0.8"></label>
        <label class="mnemosyne-setting"><span>Near-optimal tolerance</span><input type="number" min="1" step="0.01" data-setting="segmentNearOptimalRatio" value="1.05"></label>
        <label class="mnemosyne-setting"><span>Safe-plan overhead</span><input type="number" min="1" step="0.05" data-setting="segmentSafeOverheadRatio" value="1.2"></label>
        <label class="mnemosyne-setting"><span>Extraction input budget</span><input type="number" min="512" data-setting="extractionInputBudget" value="${8_000}"></label>
        <label class="mnemosyne-setting"><span>Extraction max output</span><input type="number" min="256" data-setting="extractionMaxOutputTokens" value="${4_000}"></label>
        <label class="mnemosyne-setting"><span>Rebuild total input budget</span><input type="number" min="0" data-setting="rebuildTotalInputBudget" value="${110_000}"></label>
        <label class="mnemosyne-setting"><span>Preemptive compaction ratio</span><input type="number" min="0.5" max="1" step="0.01" data-setting="preemptiveRatio" value="${0.85}"></label>
        <label class="mnemosyne-setting"><span>Integrity audit interval<small>Received messages; 0 means off.</small></span><input type="number" min="0" step="1" data-setting="integrityAuditIntervalMessages" value="${5}"></label>
        <label class="mnemosyne-setting"><span>Commitment age-out<small>Later segments without a new transition; 0 disables. Source records are preserved.</small></span><input type="number" min="0" max="1000" step="1" data-setting="commitmentAgeOutSegments" value="${8}"></label>
        <label class="mnemosyne-setting"><span>Context state budget</span><input type="number" min="0" data-setting="contextStateBudget" value="${800}"></label>
        <label class="mnemosyne-setting"><span>Context registers budget</span><input type="number" min="0" data-setting="contextRegistersBudget" value="${300}"></label>
        <label class="mnemosyne-setting"><span>Context chronological budget</span><input type="number" min="0" data-setting="contextChronologicalBudget" value="${2_500}"></label>
        <label class="mnemosyne-setting"><span>Context associative budget</span><input type="number" min="0" data-setting="contextAssociativeBudget" value="${1_500}"></label>
        <label class="mnemosyne-setting"><span>Extraction state budget</span><input type="number" min="0" data-setting="extractionStateBudget" value="${900}"></label>
        <label class="mnemosyne-setting"><span>Extraction chronological budget</span><input type="number" min="0" data-setting="extractionChronologicalBudget" value="${1_600}"></label>
        <label class="mnemosyne-setting"><span>Extraction historical budget</span><input type="number" min="0" data-setting="extractionHistoricalBudget" value="${800}"></label>
        <label class="mnemosyne-setting"><span>Extraction raw-prelude budget</span><input type="number" min="0" data-setting="extractionRawPreludeBudget" value="${600}"></label>
        <label class="mnemosyne-setting"><span>Continuity state budget</span><input type="number" min="0" data-setting="extractionContinuityStateBudget" value="${600}"></label>
        <label class="mnemosyne-setting"><span>Continuity raw-prelude budget</span><input type="number" min="0" data-setting="extractionContinuityRawPreludeBudget" value="${250}"></label>
        <label class="mnemosyne-setting"><span>Repair state budget</span><input type="number" min="0" data-setting="extractionRepairStateBudget" value="${256}"></label>
        <label class="mnemosyne-setting"><span>Fallback digest budget</span><input type="number" min="0" data-setting="extractionFallbackDigestBudget" value="${192}"></label>
        <label class="mnemosyne-setting"><span>Extraction retries</span><input type="number" min="0" max="3" step="1" data-setting="memoryExtractionRetries" value="${1}"></label>
        <label class="checkbox_label mnemosyne-toggle mnemosyne-setting--wide"><input type="checkbox" data-setting="preferFallbackExtraction"><span>Prefer tagged fallback extraction</span></label>
        <label class="checkbox_label mnemosyne-toggle mnemosyne-setting--wide"><input type="checkbox" data-setting="injectIntoQuietGenerations"><span>Inject memory into quiet generations</span></label>
        <label class="checkbox_label mnemosyne-toggle mnemosyne-setting--wide"><input type="checkbox" data-setting="telemetryEnabled"><span>Enable local operational telemetry</span></label>
        <label class="mnemosyne-setting"><span>Telemetry log level</span><select data-setting="telemetryLogLevel"><option value="debug">Debug (render diagnostics)</option><option value="info">Info</option><option value="warn">Warnings only</option><option value="error">Errors only</option><option value="silent">Silent</option></select></label>
        <label class="mnemosyne-setting"><span>Telemetry ring entries</span><input type="number" min="0" max="5000" step="50" data-setting="telemetryMaxEntries" value="500"></label>
      </div>
    </details>

    <div id="mnemosyne-inspector-shell" class="mnemosyne-inspector-shell"><div class="mnemosyne-popout-header"><strong>Mnemosyne memory</strong><button id="mnemosyne-popout-close" class="menu_button">Close expanded view</button></div>
    <section class="mnemosyne-section mnemosyne-section--actions" aria-labelledby="mnemosyne-actions-title"><div class="mnemosyne-section-heading"><div><h3 id="mnemosyne-actions-title">Memory data & operations</h3><p>Export, import, rebuild and inspect without changing the raw chat.</p></div></div>
    <div class="mnemosyne-action-groups"><div class="mnemosyne-action-group"><span>Inspect & transfer</span><div class="mnemosyne-actions"><button id="mnemosyne-export-memory" class="mnemosyne-button-secondary" title="Export the active semantic memory">Export memory</button><label class="menu_button" title="Import semantic memory for this chat">Import memory<input id="mnemosyne-import-memory" type="file" accept="application/json" hidden></label><label class="menu_button" title="Import a recorded rebuild session">Import replay session<input id="mnemosyne-import-rebuild" type="file" accept="application/json" hidden></label></div></div><div class="mnemosyne-action-group"><span>Rebuild</span><div class="mnemosyne-actions"><button id="mnemosyne-rebuild-full" class="mnemosyne-button-primary">Full rebuild</button><button id="mnemosyne-rebuild-indexes">Indexes only</button></div></div><div class="mnemosyne-action-group"><span>Diagnostics</span><div class="mnemosyne-actions"><button id="mnemosyne-export-diagnostics">Export diagnostics</button></div></div></div></section>
    <div id="mnemosyne-generation-status"></div>
    <details><summary>Effective profile</summary><div id="mnemosyne-profile-status"></div><div id="mnemosyne-profile-overrides"><p class="mnemosyne-muted">Optional overrides apply only to this chat. Leave a field empty to inherit the resolved profile.</p><label>Managed context <input type="number" min="512" data-profile-field="contextBudget"></label><label>Raw foreground <input type="number" min="256" data-profile-field="rawTailBudget"></label><label>Cooldown (ms) <input type="number" min="0" step="250" data-profile-field="memoryCooldownMs"></label><label>Connection profile <input data-profile-field="memoryConnectionProfileId"></label><div class="mnemosyne-actions"><button id="mnemosyne-profile-save" type="button">Save chat overrides</button><button id="mnemosyne-profile-clear" type="button">Clear chat overrides</button></div></div><div id="mnemosyne-scoped-profile-editor"></div></details>
    <div id="mnemosyne-token-guard-status"></div>
    <div id="mnemosyne-integrity-status"></div>
    <details open><summary>Historical backfill</summary><p class="mnemosyne-muted">Analyze first. Backfill derives memory only for history older than the lossless raw foreground and never edits raw chat.</p><div class="mnemosyne-actions"><button id="mnemosyne-backfill-analyze">Analyze chat</button><button id="mnemosyne-backfill-start">Start / resume</button><button id="mnemosyne-backfill-pause">Pause after current</button><button id="mnemosyne-backfill-cancel">Cancel after current</button><button id="mnemosyne-backfill-export">Export detailed report</button></div><div id="mnemosyne-backfill-status"></div></details>
    <details open><summary>Rebuild sessions</summary><div id="mnemosyne-rebuild-sessions"></div></details>
    <details open><summary>Memory timeline</summary><div class="mnemosyne-timeline-search"><input id="mnemosyne-timeline-search" type="search" placeholder="Search synopsis, entities, events, status..." aria-label="Search memory timeline"><button id="mnemosyne-timeline-clear" class="menu_button" type="button">Clear</button></div><div id="mnemosyne-timeline-bulk" class="mnemosyne-actions"><button data-bulk-action="select-page" type="button">Select page</button><button data-bulk-action="clear" type="button">Clear selection</button><button data-bulk-action="pin" type="button">Pin selected</button><button data-bulk-action="unpin" type="button">Unpin selected</button><button data-bulk-action="exclude" type="button">Exclude selected</button><button data-bulk-action="restore" type="button">Restore selected</button><span id="mnemosyne-timeline-selected-count" class="mnemosyne-muted">0 selected</span></div><div class="mnemosyne-pagination"><button id="mnemosyne-timeline-prev" class="menu_button">Previous</button><span id="mnemosyne-timeline-page">No segments</span><button id="mnemosyne-timeline-next" class="menu_button">Next</button></div><div id="mnemosyne-timeline"></div></details>
    <details><summary>Characters</summary><div id="mnemosyne-characters"></div></details>
    <details><summary>Relationships</summary><div id="mnemosyne-relationships"></div></details>
    <details><summary>Registers</summary><div id="mnemosyne-registers"></div></details>
    <details><summary>Conflicts</summary><div id="mnemosyne-conflicts"></div></details>
    <details><summary>Retrieval explanations</summary><div id="mnemosyne-retrieval"></div></details>
    <details><summary>Prompt/token preview</summary><div id="mnemosyne-token-preview"></div><div id="mnemosyne-prompt-preview"></div></details>
    <details><summary>Advanced local metrics</summary><div id="mnemosyne-metrics"></div></details>
    </div></div></div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function downloadText(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

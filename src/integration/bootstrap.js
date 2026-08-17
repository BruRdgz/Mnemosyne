import { DEFAULT_SETTINGS, MODULE_NAME } from '../core/constants.js';
import { MetricsRecorder } from '../observability/metrics-recorder.js';
import { TelemetryLogger } from '../observability/telemetry-logger.js';
import { AccelerationStore } from './acceleration-store.js';
import { StContextAdapter } from './st-context-adapter.js';
import { StEventAdapter } from './st-event-adapter.js';
import { NarrativeRuntime } from '../runtime/narrative-runtime.js';
import { createPortableEnvelope } from '../storage/semantic-store.js';
import { createDashboardModel, mountDashboard } from '../ui/dashboard.js';

export async function bootstrapMnemosyne({ getContext, extensionSettings, saveMetadataDebounced, localforage }) {
  const persistedSettings = extensionSettings[MODULE_NAME] ?? {};
  const migrateLegacyRawTail = Number(persistedSettings.rawTailBudget) === 8_000;
  extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS, ...persistedSettings };
  // 8,000 was the old raw-tail default. Migrate that legacy default once so
  // existing chats use the balanced 6,000-token foreground; intentional later
  // increases remain possible through the dashboard (and are still bounded by
  // the compiler's semantic reserve).
  if (migrateLegacyRawTail) extensionSettings[MODULE_NAME].rawTailBudget = DEFAULT_SETTINGS.rawTailBudget;
  const settings = extensionSettings[MODULE_NAME];
  const telemetry = new TelemetryLogger({
    enabled: settings.telemetryEnabled !== false,
    level: settings.telemetryLogLevel,
    maxEntries: settings.telemetryMaxEntries,
    // Unit/benchmark runtimes have no browser console to inspect. Keep their
    // local ring available without flooding test output; the real ST page gets
    // the normal console sink.
    sink: typeof document !== 'undefined' ? globalThis.console : {},
  });
  const metrics = new MetricsRecorder({ logger: telemetry });
  const context = new StContextAdapter({ getContext, saveMetadataDebounced });
  if (migrateLegacyRawTail) context.context().saveSettingsDebounced?.();
  const events = new StEventAdapter({ getContext, logger: telemetry });
  const acceleration = new AccelerationStore(localforage);

  // The semantic record is intentionally tiny until Phase 1 defines its full schema.
  // A welcome screen has chatMetadata but no durable chat target, so never save there.
  try {
    context.chatId();
    if (context.context().chatMetadata && !context.readPortableMemory()) {
      await context.writePortableMemory(createPortableEnvelope(context.chatId()));
    }
  } catch (error) {
    if (!String(error?.message).includes('No active SillyTavern chat identity')) throw error;
  }

  const narrative = new NarrativeRuntime({ context, metrics, settings, attemptStore: acceleration, logger: telemetry });
  await narrative.initialize();
  let dashboard = null;
  const disposeEvents = events.attach(event => {
    metrics.record({ operation: 'st_event', kind: event.kind, chatIdHashKey: event.chatId, messageIndex: event.messageIndex });
    void narrative.handleEvent(event)
      .then(() => { if (event.kind === 'chatChanged') dashboard?.refresh?.(); })
      .catch(error => metrics.record({ operation: 'st_event_handling', status: 'failed', kind: event.kind, errorName: error?.name ?? 'Error' }));
  });
  events.attachPromptAudit(eventData => narrative.auditFinalPrompt(eventData));
  events.attachRenderedMessageRepair({
    canRepair: messageIndex => Boolean(narrative.messageRepairTarget(messageIndex)),
    onRepair: async messageIndex => {
      try {
        const analysis = await narrative.analyzeMessageRepair(messageIndex);
        if (!analysis.segmentId) return;
        const input = analysis.projection?.inputTokens?.likely ?? analysis.projection?.inputTokens?.maximum ?? 0;
        const output = analysis.projection?.outputTokens?.target ?? analysis.projection?.outputTokens?.safetyMaximum ?? 0;
        const prompt = `Repair Mnemosyne memory covering message ${analysis.firstIndex ?? messageIndex}–${analysis.lastIndex ?? messageIndex}? This uses ${analysis.estimatedRequests ?? 0} model request(s), approximately ${input} input + ${output} output tokens. The active green candidate remains unchanged until explicit promotion.`;
        if (typeof globalThis.confirm === 'function' && globalThis.confirm(prompt) === false) return;
        await narrative.regenerateMessage(messageIndex, { autoPromote: false });
        dashboard?.refresh?.();
      } catch (error) {
        telemetry.warn('rendered_message_repair_failed', { errorName: error?.name ?? 'Error' });
      }
    },
  });
  events.attachRenderedMessageHealth({ getHealth: messageIndex => narrative.messageHealth(messageIndex) });

  async function intercept(chat, contextSize, _abort, generationType) {
    return narrative.intercept(chat, contextSize, generationType);
  }

  const setGenerationMode = value => {
    const result = narrative.setGenerationMode(value);
    context.context().saveSettingsDebounced?.();
    return result;
  };
  dashboard = mountSettingsUi(settings, narrative, metrics, value => { void narrative.setEnabled(Boolean(value)); }, context);
  // The extension can initialize after SillyTavern has already loaded the
  // active chat, so no CHAT_CHANGED event may remain for us to observe. In a
  // real browser, run the same bounded open-chat check once; Node fixtures
  // stay deterministic and do not spend a request during construction.
  if (typeof document !== 'undefined' && narrative.snapshot().chatId) {
    void narrative.scheduleCompactionOnChatOpen()
      .then(() => dashboard?.refresh?.())
      .catch(error => {
        telemetry.warn('chat_open_compaction_failed', { errorName: error?.name ?? 'Error' });
        dashboard?.refresh?.();
      });
  }
  telemetry.info('runtime_loaded', { chatIdPresent: Boolean(narrative.snapshot().chatId), generationMode: narrative.generationStatus().mode });

  return {
    context,
    telemetry,
    metrics,
    acceleration,
    narrative,
    startRebuild: options => narrative.startRebuild(options),
    resumeRebuild: (id, options) => narrative.resumeRebuild(id, options),
    getRebuildSession: id => narrative.getRebuildSession(id),
    exportRebuildSession: id => narrative.exportRebuildSession(id),
    importRebuildSession: serialized => narrative.importRebuildSession(serialized),
    replayRebuild: (id, options) => narrative.replayRebuild(id, options),
    analyzeSegmentRegeneration: id => narrative.analyzeSegmentRegeneration(id),
    regenerateSegment: (id, options) => narrative.regenerateSegment(id, options),
    retireCommitment: (segmentId, commitmentIndex) => narrative.retireCommitment(segmentId, commitmentIndex),
    messageRepairTarget: index => narrative.messageRepairTarget(index),
    messageHealth: index => narrative.messageHealth(index),
    telemetrySnapshot: () => telemetry.snapshot(),
    clearTelemetry: () => telemetry.clear(),
    invalidatePromptObservation: () => narrative.invalidatePromptObservation(),
    analyzeMessageRepair: index => narrative.analyzeMessageRepair(index),
    regenerateMessage: (index, options) => narrative.regenerateMessage(index, options),
    setGenerationMode,
    scheduleCompactionOnChatOpen: () => narrative.scheduleCompactionOnChatOpen(),
    generationStatus: () => narrative.generationStatus(),
    backfillStatus: () => narrative.backfillStatus(),
    integrityStatus: () => narrative.integrityStatus(),
    auditIntegrity: () => narrative.auditIntegrity(),
    tokenStatus: () => narrative.tokenStatus(),
    pauseBackfill: () => narrative.pauseBackfill(),
    cancelBackfill: () => narrative.cancelBackfill(),
    snapshot: () => narrative.snapshot(),
    profileStatus: () => narrative.profileStatus(),
    profileDefinitions: () => narrative.profileDefinitions(),
    setChatProfileOverrides: patch => narrative.setChatProfileOverrides(patch),
    setScopedProfile: (scope, id, patch) => narrative.setScopedProfile(scope, id, patch),
    deleteScopedProfile: (scope, id) => narrative.deleteScopedProfile(scope, id),
    refreshProfile: () => narrative.refreshProfile(),
    promoteRebuild: id => narrative.promoteRebuild(id),
    deleteRebuildSession: id => narrative.deleteRebuildSession(id),
    intercept,
    setEnabled(value) {
      void narrative.setEnabled(Boolean(value));
      if (!value) context.clearContextInjection();
    },
    dispose() {
      disposeEvents();
      dashboard?.dispose();
      context.clearContextInjection();
    },
  };
}

function mountSettingsUi(settings, narrative, metrics, onEnabledChange, context) {
  if (typeof document === 'undefined') return null;
  let panel = document.getElementById('mnemosyne-settings');
  const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  if (!host) return;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mnemosyne-settings';
    panel.className = 'mnemosyne-panel';
    host.append(panel);
  }
  const requireStore = () => {
    const store = narrative.store();
    if (!store) throw new Error('No active chat');
    return store;
  };
  const storeFacade = {
    snapshot: () => narrative.snapshot(),
    editSynopsis: (...args) => requireStore().editSynopsis(...args),
    setPinned: (...args) => requireStore().setPinned(...args),
    setExcluded: (...args) => requireStore().setExcluded(...args),
    sourceFor: id => requireStore().sourceFor(id, context.sourceMessages()),
    prepareRegeneration: (...args) => requireStore().prepareRegeneration(...args),
    replaceEnvelope: (...args) => requireStore().replaceEnvelope(...args),
  };
  const model = createDashboardModel({
    settings, store: storeFacade, metrics,
    getTelemetry: () => telemetry.snapshot(),
    getEnabled: () => narrative.isEnabled(),
    getPromptPreview: () => narrative.promptPreview(), getRetrieval: () => narrative.retrievalPreview(),
    getGenerationStatus: () => narrative.generationStatus(),
    getProfileStatus: () => narrative.profileStatus(),
    getProfileCatalog: () => narrative.profileDefinitions(),
    getIntegrityStatus: () => narrative.integrityStatus(),
    auditIntegrity: () => narrative.auditIntegrity(),
    getTokenStatus: () => narrative.tokenStatus(),
    refreshMemory: () => narrative.refreshMemory(),
    getChatId: () => narrative.snapshot().chatId,
    rebuildFull: () => narrative.rebuildAllDerived(), rebuildIndexes: () => narrative.rebuildIndexes(),
    getBackfillStatus: () => narrative.backfillStatus(),
    analyzeBackfill: options => narrative.analyzeBackfill(options), runBackfill: options => narrative.runBackfill(options),
    resumeRebuild: (id, options) => narrative.resumeRebuild(id, options),
    getRebuildSession: id => narrative.getRebuildSession(id),
    exportRebuildSession: id => narrative.exportRebuildSession(id),
    importRebuildSession: serialized => narrative.importRebuildSession(serialized),
    replayRebuild: (id, options) => narrative.replayRebuild(id, options),
    analyzeSegmentRegeneration: id => narrative.analyzeSegmentRegeneration(id),
    regenerateSegment: (id, options) => narrative.regenerateSegment(id, options),
    retireCommitment: (segmentId, commitmentIndex) => narrative.retireCommitment(segmentId, commitmentIndex),
    promoteRebuild: id => narrative.promoteRebuild(id),
    deleteRebuildSession: id => narrative.deleteRebuildSession(id),
    getSourceFor: id => storeFacade.sourceFor(id),
    focusSourceRange: (firstIndex, lastIndex) => context.focusSourceRange(firstIndex, lastIndex),
    setChatProfileOverrides: patch => narrative.setChatProfileOverrides(patch),
    setScopedProfile: (scope, id, patch) => narrative.setScopedProfile(scope, id, patch),
    deleteScopedProfile: (scope, id) => narrative.deleteScopedProfile(scope, id),
    pauseBackfill: () => narrative.pauseBackfill(), cancelBackfill: () => narrative.cancelBackfill(),
  });
  return mountDashboard(panel, model, {
    onEnabledChange,
    onSettingsChange: () => {
      // A prompt-only disable must take effect immediately, not only on the
      // next generation. Re-enabling remains lazy and causes no provider call.
      if (settings.injectManagedMemory === false) context.clearContextInjection();
      narrative.invalidatePromptObservation();
      narrative.setGenerationMode(settings.memoryGenerationMode);
      telemetry.configure({
        enabled: settings.telemetryEnabled !== false,
        level: settings.telemetryLogLevel,
        maxEntries: settings.telemetryMaxEntries,
      });
      void narrative.refreshProfile();
      context.context().saveSettingsDebounced?.();
    },
  });
}

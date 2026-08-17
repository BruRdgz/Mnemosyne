export const MODULE_NAME = 'mnemosyne';
export const MNEMOSYNE_VERSION = '0.2.0';
export const SCHEMA_VERSION = 1;
export const ENVELOPE_VERSION = 2;
export const METADATA_KEY = 'mnemosyne';
export const PROMPT_KEY = 'mnemosyne_context';

// SillyTavern 1.18 public extension-prompt contract. Keep these numeric values
// at the adapter boundary so the semantic runtime does not depend on ST internals.
export const ST_EXTENSION_PROMPT = Object.freeze({
  position: Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 }),
  role: Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 }),
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // Keep enough managed context available for state and semantic history.
  // The compiler applies an additional proportional ceiling, so a legacy
  // profile that still says 8,000 cannot crowd semantic memory out of a
  // smaller managed context.
  rawTailBudget: 6_000,
  contextBudget: 12_000,
  contextReserveTokens: 5_000,
  // Temporary safety valve while commitment lifecycle extraction is still
  // being qualified.  Zero disables age-out; otherwise an active commitment
  // is omitted from projected state after this many later segments without a
  // new transition.  The source candidate is never modified.
  commitmentAgeOutSegments: 8,
  contextStateBudget: 800,
  contextRegistersBudget: 300,
  contextChronologicalBudget: 2_500,
  contextAssociativeBudget: 1_500,
  segmentTarget: 5_000,
  segmentSoftMax: 7_000,
  segmentHardMax: 9_000,
  segmentPlannerMode: 'adaptive_balanced',
  segmentMaxTurnBundles: 5,
  segmentInputSafetyRatio: 0.8,
  segmentNearOptimalRatio: 1.05,
  segmentSafeOverheadRatio: 1.2,
  extractionInputBudget: 8_000,
  rebuildTotalInputBudget: 110_000,
  extractionMaxOutputTokens: 4_000,
  extractionStateBudget: 900,
  extractionChronologicalBudget: 1_600,
  extractionHistoricalBudget: 800,
  extractionRawPreludeBudget: 600,
  extractionContinuityStateBudget: 600,
  extractionContinuityRawPreludeBudget: 250,
  extractionRepairStateBudget: 256,
  extractionFallbackDigestBudget: 192,
  memoryPricingInputMultiplier: 0.5,
  memoryPricingOutputMultiplier: 0.7,
  memoryPricingCacheMultiplier: 0.1,
  memorySessionTokenCap: 0,
  memoryDailyTokenCap: 0,
  memoryCooldownMs: 3_000,
  memoryTemperature: 0.2,
  memoryTopP: 1,
  preferFallbackExtraction: false,
  memoryExtractionRetries: 1,
  // Operational telemetry is local-only.  Keep the console at info by
  // default; detailed per-render diagnostics are debug-level and opt-in.
  telemetryEnabled: true,
  telemetryLogLevel: 'info',
  telemetryMaxEntries: 500,
  memoryConnectionProfileId: null,
  memoryGroupParticipantNames: '',
  memoryGenerationMode: 'live',
  metricsEnabled: true,
  autoCompact: true,
  // Keep local extraction and persistence available while allowing users to
  // remove managed summaries from ordinary provider prompts explicitly.
  injectManagedMemory: true,
  preemptiveRatio: 0.85,
  integrityAuditIntervalMessages: 5,
  retrievalMode: 'lexical',
  collapseSensitivePreviews: true,
  injectIntoQuietGenerations: false,
});

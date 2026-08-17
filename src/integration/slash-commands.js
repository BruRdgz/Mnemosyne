const GENERATION_MODES = new Set(['live', 'replay', 'offline']);
const REGISTERED = new WeakMap();

function textArgument(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(' ').trim();
  return typeof value === 'string' ? value.trim() : '';
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on', 'confirm'].includes(String(value ?? '').trim().toLowerCase());
}

function compactNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
}

function statusLine(runtime) {
  const generation = runtime.generationStatus?.() ?? {};
  const backfill = runtime.backfillStatus?.() ?? {};
  const integrity = runtime.integrityStatus?.() ?? {};
  const tokens = runtime.tokenStatus?.() ?? {};
  const analysis = backfill.analysis ?? {};
  return [
    `mode=${generation.mode ?? 'live'}`,
    `operation=${generation.operation ?? 'idle'}`,
    `current=${generation.currentSegmentOrdinal ?? '—'}/${generation.totalSegments ?? '—'}`,
    `backfill=${backfill.status ?? 'idle'}`,
    `planned=${compactNumber(analysis.plannedSegmentCount ?? 0)}`,
    `integrity=${integrity.status ?? 'unknown'}`,
    `sessionTokens=${compactNumber(tokens.session?.spent ?? tokens.sessionSpent ?? tokens.sessionSpentTokens ?? 0)}`,
    `dailyTokens=${compactNumber(tokens.daily?.spent ?? tokens.dailySpent ?? tokens.dailySpentTokens ?? 0)}`,
  ].join(' · ');
}

function auditPayload(runtime) {
  const generation = runtime.generationStatus?.() ?? {};
  const backfill = runtime.backfillStatus?.() ?? {};
  const integrity = runtime.integrityStatus?.() ?? {};
  const tokens = runtime.tokenStatus?.() ?? {};
  const analysis = backfill.analysis ?? {};
  return {
    mode: generation.mode ?? 'live',
    operation: generation.operation ?? 'idle',
    replay: {
      sessionId: generation.replaySessionId ?? null,
      availableSegments: generation.availableSegmentCount ?? 0,
      missingSegments: generation.missingSegmentCount ?? 0,
      attempts: generation.availableAttemptCount ?? 0,
    },
    backfill: {
      status: backfill.status ?? 'idle',
      planned: analysis.plannedSegmentCount ?? 0,
      preservedGreen: analysis.preservedValidCount ?? 0,
      executionMode: analysis.executionMode ?? generation.mode ?? 'live',
    },
    integrity: {
      status: integrity.status ?? 'unknown',
      checkedSegments: integrity.checkedSegments ?? 0,
      staleSegments: integrity.staleSegments ?? 0,
      firstChangedIndex: integrity.firstChangedIndex ?? null,
    },
    tokens: {
      sessionSpent: tokens.session?.spent ?? tokens.sessionSpent ?? tokens.sessionSpentTokens ?? 0,
      dailySpent: tokens.daily?.spent ?? tokens.dailySpent ?? tokens.dailySpentTokens ?? 0,
      reserved: tokens.reserved ?? tokens.reservedTokens ?? 0,
      ledgerHealthy: tokens.ledgerHealthy ?? true,
    },
  };
}

function sessionIdFrom(runtime, unnamed) {
  const requested = textArgument(unnamed);
  if (requested) return requested;
  const sessions = runtime.snapshot?.().rebuildSessions ?? [];
  return [...sessions]
    .filter(session => ['planned', 'running', 'incomplete'].includes(session.status))
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0]?.id ?? null;
}

function register(parser, name, callback, aliases = [], helpString = '') {
  if (typeof parser?.addCommand !== 'function') return null;
  parser.addCommand(name, callback, aliases, helpString);
  const commands = parser.commands;
  const command = commands?.[name];
  return { name, aliases, callback, command };
}

/**
 * Registers only provider-free operational commands. The caller supplies the
 * SillyTavern SlashCommandParser so the semantic runtime remains testable and
 * does not import private ST modules.
 */
export function registerMnemosyneSlashCommands({ parser, runtime, notify = null } = {}) {
  if (!parser || !runtime || typeof parser.addCommand !== 'function') return () => {};
  const previous = REGISTERED.get(parser);
  if (previous) return previous.dispose;
  const entries = [];
  const announce = value => { notify?.(value); return value; };

  entries.push(register(parser, 'mnemosyne-status', () => announce(statusLine(runtime)), ['mnemo-status'], 'Show Mnemosyne runtime status without generating memory.'));
  entries.push(register(parser, 'mnemosyne-audit', async () => {
    // An explicit audit is local-only. It refreshes source fingerprints before
    // serializing the status, but never routes through a generation adapter.
    await runtime.auditIntegrity?.();
    return announce(JSON.stringify(auditPayload(runtime)));
  }, ['mnemo-audit'], 'Audit source integrity locally, then show narrative-free replay, backfill, and token status.'));
  entries.push(register(parser, 'mnemosyne-mode', (_args, unnamed) => {
    const mode = textArgument(unnamed).toLowerCase();
    if (!GENERATION_MODES.has(mode)) return announce('Usage: /mnemosyne-mode live|replay|offline');
    const result = runtime.setGenerationMode?.(mode);
    return announce(`Mnemosyne generation mode: ${result?.mode ?? mode}`);
  }, ['mnemo-mode'], 'Set live, replay, or offline memory generation mode.'));
  entries.push(register(parser, 'mnemosyne-pause', () => announce(runtime.pauseBackfill?.() ? 'Mnemosyne will pause after the current segment.' : 'No running Mnemosyne rebuild to pause.'), ['mnemo-pause'], 'Pause historical memory work after the current segment.'));
  entries.push(register(parser, 'mnemosyne-resume', async (args, unnamed) => {
    const id = sessionIdFrom(runtime, unnamed);
    if (!id) return announce('No planned, running, or incomplete rebuild session is available.');
    if (!truthy(args?.confirm)) return announce(`Resume ${id} requires confirm=true; no request was started.`);
    const result = await runtime.resumeRebuild?.(id, { autoPromote: false });
    return announce(`Mnemosyne rebuild ${id}: ${result?.session?.status ?? result?.status ?? 'finished'}`);
  }, ['mnemo-resume'], 'Resume an existing rebuild only with confirm=true; never starts an unplanned rebuild.'));
  entries.push(register(parser, 'mnemosyne-replay', async (args, unnamed) => {
    const id = sessionIdFrom(runtime, unnamed);
    if (!id) return announce('No replayable rebuild session is available.');
    const result = await runtime.replayRebuild?.(id, { autoPromote: false });
    return announce(`Mnemosyne replay ${id}: ${result?.session?.status ?? result?.status ?? 'finished'} (0 new requests)`);
  }, ['mnemo-replay'], 'Replay recorded outputs for a compatible rebuild session without provider requests.'));
  entries.push(register(parser, 'mnemosyne-repair', async (args, unnamed) => {
    const id = textArgument(unnamed);
    if (!id) return announce('Usage: /mnemosyne-repair <segmentId> confirm=true');
    const analysis = await runtime.analyzeSegmentRegeneration?.(id);
    if (!truthy(args?.confirm)) return announce(`Repair ${id} analyzed: ${JSON.stringify({ segmentId: analysis?.segmentId, executionMode: analysis?.executionMode, estimatedRequests: analysis?.estimatedRequests, projection: analysis?.projection })}. No request was started; rerun with confirm=true.`);
    const result = await runtime.regenerateSegment?.(id, { autoPromote: false });
    return announce(`Mnemosyne repair ${id}: ${result?.session?.status ?? result?.status ?? 'finished'}; active baseline unchanged until promotion.`);
  }, ['mnemo-repair'], 'Analyze or explicitly repair one segment; provider work requires confirm=true.'));

  const validEntries = entries.filter(Boolean);
  const dispose = () => {
    for (const entry of validEntries) {
      for (const key of [entry.name, ...entry.aliases]) {
        if (parser.commands?.[key]?.callback === entry.callback) delete parser.commands[key];
      }
    }
    REGISTERED.delete(parser);
  };
  REGISTERED.set(parser, { dispose });
  return dispose;
}

export function mnemosyneCommandStatus(runtime) { return statusLine(runtime); }
export function mnemosyneCommandAudit(runtime) { return auditPayload(runtime); }

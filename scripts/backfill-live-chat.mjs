import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapMnemosyne } from '../src/integration/bootstrap.js';
import { parseStructured } from '../src/extraction/extraction-engine.js';
import { DEFAULT_SETTINGS } from '../src/core/constants.js';

function argumentsOf(argv) {
  const result = { apply: false, baseUrl: 'http://127.0.0.1:8000', cooldownMs: 3_000, executionMode: 'live' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') result.apply = true;
    else if (value === '--chat') result.chatPath = argv[++index];
    else if (value === '--base-url') result.baseUrl = argv[++index];
    else if (value === '--only-range') result.onlyRange = argv[++index];
    else if (value === '--cooldown-ms') result.cooldownMs = Number(argv[++index]);
    else if (value === '--segment-target') result.segmentTarget = Number(argv[++index]);
    else if (value === '--segment-soft-max') result.segmentSoftMax = Number(argv[++index]);
    else if (value === '--segment-hard-max') result.segmentHardMax = Number(argv[++index]);
    else if (value === '--model') result.model = argv[++index];
    else if (value === '--fallback-first') result.fallbackFirst = true;
    else if (value === '--structured-only') result.structuredOnly = true;
    else if (value === '--continue-on-failure') result.continueOnFailure = true;
    else if (value === '--diagnose') result.diagnose = true;
    else if (value === '--checkpoint') result.checkpoint = argv[++index];
    else if (value === '--replay-artifact') { result.replayArtifact = argv[++index]; result.executionMode = 'replay'; }
    else if (value === '--replay-attempts') result.replayAttempts = argv[++index];
    else if (value === '--offline') result.executionMode = 'offline';
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!result.chatPath) throw new Error('Usage: node scripts/backfill-live-chat.mjs --chat <absolute-jsonl-path> [--apply]');
  if (result.apply && result.onlyRange) throw new Error('--apply cannot be combined with --only-range');
  if (result.replayArtifact && result.executionMode === 'offline') throw new Error('--replay-artifact cannot be combined with --offline');
  if (result.replayAttempts && !result.replayArtifact) throw new Error('--replay-attempts requires --replay-artifact');
  if (result.checkpoint && path.resolve(result.checkpoint) === path.resolve(result.chatPath)) throw new Error('Checkpoint path must not be the chat history file');
  const segmentBudgets = [result.segmentTarget, result.segmentSoftMax, result.segmentHardMax].filter(value => value !== undefined);
  if (segmentBudgets.some(value => !Number.isInteger(value) || value <= 0)) throw new Error('Segment budgets must be positive integers');
  if (segmentBudgets.length && segmentBudgets.length !== 3) throw new Error('Provide all three segment budget arguments together');
  if (segmentBudgets.length && !(result.segmentTarget <= result.segmentSoftMax && result.segmentSoftMax <= result.segmentHardMax)) {
    throw new Error('Segment budgets must satisfy target <= soft max <= hard max');
  }
  return result;
}

async function loadReplayArtifact(artifactPath, attemptsPath = `${artifactPath}.attempts.jsonl`) {
  const parsed = JSON.parse(await readFile(artifactPath, 'utf8'));
  if (parsed?.session) {
    return { version: parsed.version ?? 2, session: parsed.session, rawAttempts: parsed.rawAttempts ?? [] };
  }
  const sessions = parsed?.envelope?.rebuildSessions;
  let sidecarRecords = [];
  try {
    sidecarRecords = (await readFile(attemptsPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const session = Array.isArray(sessions)
    ? [...sessions]
      .filter(item => ['promoted', 'complete', 'incomplete', 'planned', 'running'].includes(item.status))
      .sort((a, b) => {
        const aCount = sidecarRecords.filter(record => record?.key?.startsWith(`rebuild:${a.id}:`) && !record.key.endsWith(':index')).length;
        const bCount = sidecarRecords.filter(record => record?.key?.startsWith(`rebuild:${b.id}:`) && !record.key.endsWith(':index')).length;
        return bCount - aCount || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
      })[0]
    : null;
  if (!session) throw new Error('Replay artifact does not contain a rebuild session');
  const rawAttempts = sidecarRecords
    .filter(record => record?.key?.startsWith(`rebuild:${session.id}:`) && !record.key.endsWith(':index'))
    .map(record => ({ ref: record.key, value: record.value }));
  return { version: parsed.version ?? 2, session, rawAttempts };
}

function parseJsonl(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function withoutMnemosyne(header) {
  const copy = structuredClone(header);
  if (copy.chat_metadata) delete copy.chat_metadata.mnemosyne;
  return copy;
}

async function createPersistentLocalForage(logPath) {
  const stores = new Map();
  try {
    for (const line of (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      if (!stores.has(record.store)) stores.set(record.store, new Map());
      if (record.deleted) stores.get(record.store).delete(record.key);
      else stores.get(record.store).set(record.key, record.value);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    createInstance(options = {}) {
      const storeName = String(options.storeName ?? 'default');
      if (!stores.has(storeName)) stores.set(storeName, new Map());
      const values = stores.get(storeName);
      return {
        setItem: async (key, value) => {
          const stored = structuredClone(value);
          values.set(key, stored);
          await appendFile(logPath, `${JSON.stringify({ store: storeName, key, value: stored })}\n`, 'utf8');
          return value;
        },
        getItem: async key => structuredClone(values.get(key) ?? null),
        keys: async () => [...values.keys()],
        removeItem: async key => {
          values.delete(key);
          await appendFile(logPath, `${JSON.stringify({ store: storeName, key, deleted: true })}\n`, 'utf8');
          return true;
        },
      };
    },
  };
}

async function createSillyTavernClient(baseUrl, cooldownMs, modelOverride) {
  const traces = [];
  let nextProviderAt = 0;
  const csrfResponse = await fetch(`${baseUrl}/csrf-token`);
  if (!csrfResponse.ok) throw new Error(`CSRF bootstrap failed with HTTP ${csrfResponse.status}`);
  const cookies = (csrfResponse.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
  const { token } = await csrfResponse.json();
  const headers = { 'content-type': 'application/json', 'x-csrf-token': token, cookie: cookies };

  async function post(route, body) {
    const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  const settingsPayload = await post('/api/settings/get', {});
  const settings = JSON.parse(settingsPayload.settings);
  const oai = settings.oai_settings;
  if (settings.main_api !== 'openai') throw new Error(`Unsupported active API for this utility: ${settings.main_api}`);

  async function countTokens(text) {
    const result = await post('/api/tokenizers/openai/count?model=gemini', [{ content: String(text) }]);
    return Math.max(1, Number(result.token_count));
  }

  async function generateRaw({ systemPrompt = '', prompt = '', responseLength = 6_000, jsonSchema = null } = {}) {
    const delay = Math.max(0, nextProviderAt - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    nextProviderAt = Date.now() + Math.max(0, Number(cooldownMs) || 0);
    const voidAiJsonMode = Boolean(jsonSchema) && (() => {
      try { return new URL(oai.custom_url).hostname.toLowerCase().endsWith('voidai.app'); } catch { return false; }
    })();
    const effectiveSystemPrompt = voidAiJsonMode
      ? `${String(systemPrompt)}\n\nVoidAI JSON mode is active. Return exactly one JSON object, without Markdown or commentary. The object must satisfy this JSON Schema; validation is performed locally:\n${JSON.stringify(jsonSchema.promptValue ?? jsonSchema.value ?? jsonSchema)}`
      : String(systemPrompt);
    const includeBody = voidAiJsonMode
      ? `${String(oai.custom_include_body ?? '').trim()}\nresponse_format:\n  type: json_object`.trim()
      : oai.custom_include_body;
    const request = {
      type: 'quiet',
      messages: [
        { role: 'system', content: effectiveSystemPrompt },
        { role: 'user', content: String(prompt) },
      ],
      model: modelOverride || oai.custom_model,
      temperature: Number(oai.temp_openai),
      frequency_penalty: Number(oai.freq_pen_openai),
      presence_penalty: Number(oai.pres_pen_openai),
      top_p: Number(oai.top_p_openai),
      max_tokens: responseLength,
      stream: false,
      chat_completion_source: oai.chat_completion_source,
      include_reasoning: false,
      custom_prompt_post_processing: oai.custom_prompt_post_processing,
      custom_url: oai.custom_url,
      custom_include_body: includeBody,
      custom_exclude_body: oai.custom_exclude_body,
      custom_include_headers: oai.custom_include_headers,
      ...(jsonSchema && !voidAiJsonMode ? { json_schema: jsonSchema } : {}),
    };
    let data;
    try {
      data = await post('/api/backends/chat-completions/generate', request);
    } catch (error) {
      traces.push({ mode: jsonSchema ? 'structured' : 'fallback', error: String(error?.message ?? error) });
      throw error;
    }
    if (data?.quota_error || data?.error) {
      const message = String(data?.error?.message ?? data?.error ?? data.quota_error).slice(0, 240);
      const error = new Error(`Provider response error: ${message}`);
      error.code = data.quota_error || /payment required|insufficient (?:funds|credit)|credits? exhausted|quota/i.test(message)
        ? 'quota'
        : (/too many requests/i.test(message)
            ? 'rate_limit'
            : (/forbidden|access denied/i.test(message)
                ? 'access_denied'
                : (/service unavailable/i.test(message) ? 'unavailable' : 'no_content')));
      traces.push({ mode: jsonSchema ? 'structured' : 'fallback', error: error.message });
      throw error;
    }
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.content ?? data?.response;
    if (content === undefined || content === null || content === '') {
      const keys = data && typeof data === 'object' ? Object.keys(data).sort().join(',') : typeof data;
      throw new Error(`Provider returned no completion content (keys: ${keys || 'none'})`);
    }
    const normalizedContent = typeof content === 'string' ? content : JSON.stringify(content);
    traces.push({ mode: jsonSchema ? 'structured' : 'fallback', content: normalizedContent });
    return { content: normalizedContent, usage: data?.usage ?? null, id: data?.id ?? null, model: data?.model ?? request.model, choices: data?.choices ?? [] };
  }

  async function processRequest(request) {
    const data = await post('/api/backends/chat-completions/generate', { type: 'quiet', include_reasoning: false, ...request });
    if (data?.quota_error || data?.error) {
      const message = String(data?.error?.message ?? data?.error ?? data.quota_error).slice(0, 240);
      const error = new Error(`Provider response error: ${message}`);
      error.code = data.quota_error || /payment required|insufficient (?:funds|credit)|credits? exhausted|quota/i.test(message)
        ? 'quota'
        : (/too many requests/i.test(message) ? 'rate_limit' : (/forbidden|access denied/i.test(message) ? 'access_denied' : (/service unavailable/i.test(message) ? 'unavailable' : 'no_content')));
      throw error;
    }
    return data;
  }

  return { post, settings, countTokens, generateRaw, processRequest, traces };
}

function semanticCounts(envelope) {
  const fields = ['entities', 'events', 'observations', 'stateChanges', 'knowledgeChanges', 'relationshipChanges', 'commitments', 'threads', 'salientNegatives', 'registerObservations', 'interpretations', 'temporal', 'locations'];
  const valid = envelope.segments.filter(segment => segment.status === 'valid' && segment.extraction?.replacementEligible !== false);
  return Object.fromEntries(fields.map(field => [field, valid.reduce((sum, segment) => sum + (segment.summary?.[field]?.length ?? 0), 0)]));
}

const options = argumentsOf(process.argv.slice(2));
const originalRows = parseJsonl(await readFile(options.chatPath, 'utf8'));
if (originalRows.length < 2) throw new Error('Chat JSONL must contain a header and at least one message');
const [originalHeader, ...messages] = originalRows;
const chatId = path.basename(options.chatPath, '.jsonl');
const avatarFolder = path.basename(path.dirname(options.chatPath));
const rawMessageHash = stableHash(messages);
const nonMemoryHeaderHash = stableHash(withoutMnemosyne(originalHeader));
const replayArtifact = options.replayArtifact
  ? await loadReplayArtifact(options.replayArtifact, options.replayAttempts ?? `${options.replayArtifact}.attempts.jsonl`)
  : null;
const client = await createSillyTavernClient(options.baseUrl, options.cooldownMs, options.model);
const context = {
  chatId,
  chat: structuredClone(messages),
  chatMetadata: structuredClone(originalHeader.chat_metadata ?? {}),
  getTokenCountAsync: client.countTokens,
  saveMetadata: async () => {},
  mainApi: 'openai',
  chatCompletionSettings: client.settings.oai_settings,
  getChatCompletionModel: settings => options.model || settings.custom_model,
  ChatCompletionService: { processRequest: request => client.processRequest(request) },
  generateRaw: async generationOptions => {
    try {
      return await client.generateRaw(generationOptions);
    } catch (error) {
      console.error(`[live-backfill provider] ${String(error?.message ?? error)}`);
      throw error;
    }
  },
  setExtensionPrompt: () => {},
  symbols: { ignore: Symbol.for('mnemosyne-live-backfill-ignore') },
  eventSource: { on: () => {}, removeListener: () => {} },
  eventTypes: {},
};
if (options.onlyRange) {
  const match = /^(\d+):(\d+)$/.exec(options.onlyRange);
  if (!match) throw new Error('--only-range must use first:last numeric syntax');
  const [first, last] = match.slice(1).map(Number);
  const segments = context.chatMetadata?.mnemosyne?.segments;
  if (!Array.isArray(segments)) throw new Error('The chat has no existing Mnemosyne segments to isolate');
  let found = false;
  context.chatMetadata.mnemosyne.segments = segments.map(segment => {
    if (segment.source?.first?.messageIndex !== first || segment.source?.last?.messageIndex !== last) return segment;
    found = true;
    return { ...segment, status: 'stale', staleReason: 'isolated_diagnostic' };
  });
  if (!found) throw new Error(`No existing segment matches ${options.onlyRange}`);
}
const extensionSettings = { mnemosyne: { ...DEFAULT_SETTINGS, ...(client.settings.extension_settings?.mnemosyne ?? {}) } };
extensionSettings.mnemosyne.memoryGenerationMode = options.executionMode;
if (options.fallbackFirst) extensionSettings.mnemosyne.preferFallbackExtraction = true;
if (options.structuredOnly) extensionSettings.mnemosyne.memoryExtractionRetries = 0;
if (options.segmentTarget !== undefined) {
  extensionSettings.mnemosyne.segmentTarget = options.segmentTarget;
  extensionSettings.mnemosyne.segmentSoftMax = options.segmentSoftMax;
  extensionSettings.mnemosyne.segmentHardMax = options.segmentHardMax;
}
const checkpointKey = stableHash({
  version: 2,
  chatId,
  rawMessageHash,
  nonMemoryHeaderHash,
  model: options.model || client.settings.oai_settings.custom_model,
  segmentTarget: extensionSettings.mnemosyne.segmentTarget,
  segmentSoftMax: extensionSettings.mnemosyne.segmentSoftMax,
  segmentHardMax: extensionSettings.mnemosyne.segmentHardMax,
  promptVersion: 2,
  extractionInputBudget: extensionSettings.mnemosyne.extractionInputBudget,
  rebuildTotalInputBudget: extensionSettings.mnemosyne.rebuildTotalInputBudget,
  extractionMaxOutputTokens: extensionSettings.mnemosyne.extractionMaxOutputTokens,
  extractionStateBudget: extensionSettings.mnemosyne.extractionStateBudget,
  extractionChronologicalBudget: extensionSettings.mnemosyne.extractionChronologicalBudget,
  extractionHistoricalBudget: extensionSettings.mnemosyne.extractionHistoricalBudget,
  extractionRawPreludeBudget: extensionSettings.mnemosyne.extractionRawPreludeBudget,
});
options.checkpoint ??= path.resolve(process.cwd(), `MNEMOSYNE_BACKFILL_CANDIDATE_${checkpointKey.slice(0, 16)}.json`);
if (path.resolve(options.checkpoint) === path.resolve(options.chatPath)) throw new Error('Checkpoint path must not be the chat history file');
const writeCheckpoint = envelope => writeFile(options.checkpoint, `${JSON.stringify({
  version: 2,
  key: checkpointKey,
  savedAt: new Date().toISOString(),
  complete: ['complete', 'promoted'].includes(envelope.rebuildSessions?.at(-1)?.status),
  envelope,
})}\n`, 'utf8');
const rawAttemptLog = `${options.checkpoint}.attempts.jsonl`;
const localforage = await createPersistentLocalForage(rawAttemptLog);
context.saveMetadata = async () => {
  await writeCheckpoint(context.chatMetadata.mnemosyne);
  if (!options.apply) return;
  const currentRows = await client.post('/api/chats/get', { avatar_url: `${avatarFolder}.png`, file_name: chatId });
  const [currentHeader, ...currentMessages] = currentRows;
  if (stableHash(currentMessages) !== rawMessageHash) throw new Error('Chat messages changed while candidate state was being persisted');
  if (stableHash(withoutMnemosyne(currentHeader)) !== nonMemoryHeaderHash) throw new Error('Non-Mnemosyne metadata changed while candidate state was being persisted');
  currentHeader.chat_metadata ??= {};
  currentHeader.chat_metadata.mnemosyne = structuredClone(context.chatMetadata.mnemosyne);
  await client.post('/api/chats/save', { avatar_url: `${avatarFolder}.png`, file_name: chatId, chat: [currentHeader, ...currentMessages], force: false });
};
let resumedFromCheckpoint = false;
if (options.checkpoint && !replayArtifact && options.executionMode !== 'offline') {
  try {
    const checkpoint = JSON.parse(await readFile(options.checkpoint, 'utf8'));
    if (checkpoint?.version !== 2 || checkpoint?.key !== checkpointKey || !checkpoint?.envelope) {
      throw new Error('Checkpoint does not match this chat, model, source, and segment configuration');
    }
    context.chatMetadata.mnemosyne = structuredClone(checkpoint.envelope);
    resumedFromCheckpoint = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
const runtime = await bootstrapMnemosyne({
  getContext: () => context,
  extensionSettings,
  localforage,
});

try {
  let result;
  if (replayArtifact) {
    const imported = await runtime.narrative.importRebuildSession(replayArtifact);
    result = await runtime.narrative.replayRebuild(imported.id, {
      autoPromote: false,
      onProgress: async () => writeCheckpoint(runtime.narrative.snapshot()),
    });
    if (options.apply && ['complete', 'promoted'].includes(result.session?.status)) {
      result = { ...result, session: await runtime.narrative.promoteRebuild(imported.id) };
    }
  } else {
    result = await runtime.narrative.runBackfill({
      rebuild: !options.onlyRange && !resumedFromCheckpoint,
      retryFailed: resumedFromCheckpoint,
      stopOnFailure: !options.continueOnFailure,
      executionMode: options.executionMode,
      onProgress: async () => writeCheckpoint(runtime.narrative.snapshot()),
    });
  }
  const envelope = runtime.narrative.snapshot();
  const candidateSegments = result.session?.segments ?? [];
  const candidateEnvelope = { segments: candidateSegments };
  const invariant = {
    rawMessagesUnchanged: stableHash(context.chat) === rawMessageHash,
    nonMemoryHeaderUnchanged: stableHash(withoutMnemosyne({ ...originalHeader, chat_metadata: context.chatMetadata })) === nonMemoryHeaderHash,
  };
  if (!invariant.rawMessagesUnchanged || !invariant.nonMemoryHeaderUnchanged) throw new Error('Safety invariant failed before persistence');
  await writeCheckpoint(envelope);

  const report = {
    mode: `${options.apply ? 'apply' : 'dry-run'}:${options.executionMode}`,
    chatId,
    model: options.model || client.settings.oai_settings.custom_model,
    status: result.status,
    processed: result.report.processed,
    valid: result.report.valid,
    failed: result.report.failed,
    retries: result.report.retries,
    quality: Object.fromEntries(['full', 'partial', 'prose', 'failed'].map(quality => [quality, candidateSegments.filter(segment => segment.extraction?.quality === quality).length])),
    materializedEntities: result.session?.status === 'promoted' ? envelope.entities.length : null,
    materializedRegisters: result.session?.status === 'promoted' ? envelope.registers.length : null,
    semantics: semanticCounts(candidateEnvelope),
    cost: result.session?.report?.cost ?? null,
    session: result.session ? { id: result.session.id, status: result.session.status, green: result.session.plan.filter(item => item.status === 'valid').length, total: result.session.plan.length } : null,
    invariant,
    persisted: false,
    candidatePersistence: options.apply ? 'chat_metadata_checkpoint_and_sidecar' : 'checkpoint_and_sidecar',
    checkpoint: { path: path.resolve(options.checkpoint), resumed: resumedFromCheckpoint, saved: true },
    replay: replayArtifact ? { source: path.resolve(options.replayArtifact), attempts: path.resolve(options.replayAttempts ?? `${options.replayArtifact}.attempts.jsonl`), imported: true } : null,
    outputs: result.report.outputs.map((output, index) => {
      const trace = client.traces[index];
      const diagnostic = options.diagnose && trace?.mode === 'structured' && trace.content
        ? parseStructured(trace.content, { contextKey: chatId, knownEntities: envelope.entities })
        : null;
      return {
        source: output.source,
        status: output.status,
        quality: output.extraction?.quality ?? 'failed',
        format: output.extraction?.format ?? null,
        failure: output.extraction?.failure ?? null,
        attempts: output.extraction?.attempts ?? [],
        warnings: output.extraction?.warnings ?? [],
        ...(diagnostic && !diagnostic.ok ? { diagnostic: { outputCharacters: trace.content.length, reason: diagnostic.reason ?? null, errors: diagnostic.errors ?? [] } } : {}),
      };
    }),
  };
  if (options.diagnose) {
    const structuredTrace = client.traces.filter(trace => trace.mode === 'structured' && trace.content).at(-1);
    if (structuredTrace) {
      const diagnostic = parseStructured(structuredTrace.content, { contextKey: chatId, knownEntities: envelope.entities });
      report.structuredDiagnostic = {
        outputCharacters: structuredTrace.content.length,
        ok: diagnostic.ok,
        reason: diagnostic.reason ?? null,
        errors: diagnostic.errors ?? [],
      };
    }
  }

  if (result.status !== 'complete' || !['complete', 'promoted'].includes(result.session?.status)) {
    console.error(JSON.stringify(report, null, 2));
    const lastTrace = client.traces.at(-1);
    if (lastTrace) console.error(`\n===== LAST ${lastTrace.mode.toUpperCase()} RESULT (TRUNCATED) =====\n${String(lastTrace.error ?? lastTrace.content).slice(0, 4_000)}`);
    throw new Error('Backfill is incomplete; candidate state and raw attempts were preserved, and the active green baseline was not replaced');
  }

  if (options.apply) {
    const currentRows = await client.post('/api/chats/get', { avatar_url: `${avatarFolder}.png`, file_name: chatId });
    if (!Array.isArray(currentRows) || currentRows.length < 2) throw new Error('Could not reload current chat before persistence');
    const [currentHeader, ...currentMessages] = currentRows;
    if (stableHash(currentMessages) !== rawMessageHash) throw new Error('Chat messages changed while backfill was running; refusing to persist');
    if (stableHash(withoutMnemosyne(currentHeader)) !== nonMemoryHeaderHash) throw new Error('Non-Mnemosyne chat metadata changed while backfill was running; refusing to persist');
    currentHeader.chat_metadata ??= {};
    currentHeader.chat_metadata.mnemosyne = envelope;
    await client.post('/api/chats/save', {
      avatar_url: `${avatarFolder}.png`,
      file_name: chatId,
      chat: [currentHeader, ...currentMessages],
      force: false,
    });
    const verifiedRows = await client.post('/api/chats/get', { avatar_url: `${avatarFolder}.png`, file_name: chatId });
    const [verifiedHeader, ...verifiedMessages] = verifiedRows;
    if (stableHash(verifiedMessages) !== rawMessageHash) throw new Error('Post-save message verification failed');
    if (stableHash(withoutMnemosyne(verifiedHeader)) !== nonMemoryHeaderHash) throw new Error('Post-save non-memory metadata verification failed');
    if (stableHash(verifiedHeader.chat_metadata?.mnemosyne) !== stableHash(envelope)) throw new Error('Post-save Mnemosyne envelope verification failed');
    report.persisted = true;
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  runtime.dispose();
}

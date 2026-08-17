const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: Infinity });
const NARRATIVE_KEYS = new Set([
  'text', 'mes', 'content', 'prompt', 'summary', 'synopsis', 'raw',
  'response', 'payload', 'body', 'transcript', 'prose',
]);
const DIAGNOSTIC_KEYS = new Set(['error', 'errors', 'validationerror', 'validationerrors', 'warning', 'warnings']);

const INFO_OPERATIONS = new Set([
  'memory_generation',
  'generation_critical_path',
  'compaction_schedule',
  'rebuild_session',
  'rebuild_attempt',
  'replay_generation',
  'final_prompt_audit',
  'integrity_audit',
  'token_guard',
]);

const WARN_STATUSES = new Set([
  'failed', 'write_failed', 'read_failed', 'blocked', 'blocked_daily',
  'blocked_session', 'quota', 'rate_limit', 'access_denied', 'unavailable',
  'invalid', 'stale', 'cancelled', 'truncated',
]);

function normalizeLevel(value, fallback = 'info') {
  const level = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : fallback;
}

function safeDiagnostic(value) {
  return String(value ?? '')
    // Validator messages may include an invalid provider value. Keep the
    // structural path and expected vocabulary, but never mirror that value
    // into the console/diagnostic export as a narrative sink.
    .replace(/"(?:\\.|[^"\\])*"/g, '[redacted]')
    .replace(/'(?:\\.|[^'\\])*'/g, '[redacted]')
    .slice(0, 160);
}

function renderDetails(value) {
  try { return JSON.stringify(value); } catch { return '[unserializable details]'; }
}

function safeDetails(value, key = '') {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  const normalizedKey = String(key).toLowerCase();
  if (NARRATIVE_KEYS.has(normalizedKey)) return '[redacted]';
  if (DIAGNOSTIC_KEYS.has(normalizedKey)) {
    if (Array.isArray(value)) return value.slice(0, 64).map(item => safeDiagnostic(item));
    return safeDiagnostic(value);
  }
  if (typeof value === 'string') {
    // Error messages and provider payloads must never become an accidental
    // transcript sink. Callers should prefer errorName/code; this bound keeps
    // an unexpected diagnostic useful without retaining a large response.
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 64).map(item => safeDetails(item, key));
  if (typeof value !== 'object') return String(value);
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (NARRATIVE_KEYS.has(String(childKey).toLowerCase())) {
      result[childKey] = '[redacted]';
      continue;
    }
    result[childKey] = safeDetails(childValue, childKey);
  }
  return result;
}

function shouldLogMetric(metric) {
  const status = String(metric?.status ?? '').toLowerCase();
  if (WARN_STATUSES.has(status)) return 'warn';
  if (INFO_OPERATIONS.has(String(metric?.operation ?? ''))) return 'info';
  return 'debug';
}

/**
 * Small local structured logger for operational telemetry.
 *
 * It deliberately has no network sink. Entries are kept in a bounded in-memory
 * ring and optionally mirrored to the browser console. Narrative-bearing keys
 * are redacted before either destination sees them.
 */
export class TelemetryLogger {
  #enabled;
  #threshold;
  #maxEntries;
  #sink;
  #now;
  #sequence = 0;
  #entries = [];

  constructor({ enabled = true, level = 'info', maxEntries = 500, sink = globalThis.console, now = () => new Date().toISOString() } = {}) {
    this.#enabled = enabled !== false;
    this.#threshold = LEVELS[normalizeLevel(level)];
    this.#maxEntries = Math.max(0, Math.floor(Number(maxEntries) || 500));
    this.#sink = sink;
    this.#now = now;
  }

  get enabled() { return this.#enabled; }
  get level() { return Object.entries(LEVELS).find(([, value]) => value === this.#threshold)?.[0] ?? 'silent'; }

  configure({ enabled = this.#enabled, level = this.level, maxEntries = this.#maxEntries } = {}) {
    this.#enabled = enabled !== false;
    this.#threshold = LEVELS[normalizeLevel(level)];
    this.#maxEntries = Math.max(0, Math.floor(Number(maxEntries) || 500));
    if (this.#maxEntries > 0 && this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    if (this.#maxEntries === 0) this.#entries.length = 0;
    return { enabled: this.#enabled, level: this.level, maxEntries: this.#maxEntries };
  }

  log(level, event, details = {}) {
    if (!this.#enabled) return null;
    const normalizedLevel = normalizeLevel(level, 'info');
    const entry = {
      sequence: ++this.#sequence,
      timestamp: this.#now(),
      level: normalizedLevel,
      event: String(event ?? 'unknown'),
      details: safeDetails(details),
    };
    if (this.#maxEntries > 0) {
      this.#entries.push(entry);
      if (this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    }
    if (LEVELS[normalizedLevel] >= this.#threshold) {
      const method = typeof this.#sink?.[normalizedLevel] === 'function' ? normalizedLevel : 'log';
      // Keep details in the first string argument. SillyTavern's captured
      // console stream renders a second object argument as plain `Object`,
      // which hid the validation paths users need to inspect.
      try { this.#sink?.[method]?.(`[Mnemosyne] ${entry.event} ${renderDetails(entry.details)}`); } catch { /* console sinks are best effort */ }
    }
    return structuredClone(entry);
  }

  debug(event, details = {}) { return this.log('debug', event, details); }
  info(event, details = {}) { return this.log('info', event, details); }
  warn(event, details = {}) { return this.log('warn', event, details); }
  error(event, details = {}) { return this.log('error', event, details); }

  metric(metric = {}) {
    const { operation, recordedAtMs, ...details } = metric;
    return this.log(shouldLogMetric(metric), `metric.${String(operation ?? 'unknown')}`, { ...details, recordedAtMs: recordedAtMs ?? null });
  }

  snapshot() { return structuredClone(this.#entries); }
  clear() { this.#entries.length = 0; }
}

export { LEVELS, safeDetails };

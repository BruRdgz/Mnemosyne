const FORBIDDEN_KEYS = new Set(['text', 'mes', 'content', 'prompt', 'summary', 'synopsis', 'raw']);

function assertNoNarrativePayload(value, path = 'metric') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new TypeError(`Narrative-bearing metric field is forbidden: ${path}.${key}`);
    }
    assertNoNarrativePayload(nested, `${path}.${key}`);
  }
}

export class MetricsRecorder {
  #events = [];
  #now;
  #logger;

  constructor({ now = () => performance.now(), logger = null } = {}) {
    this.#now = now;
    this.#logger = logger;
  }

  record(event) {
    if (!event || typeof event.operation !== 'string' || !event.operation) {
      throw new TypeError('Metric events require a non-empty operation');
    }
    assertNoNarrativePayload(event);
    const stored = structuredClone({ recordedAtMs: this.#now(), ...event });
    this.#events.push(stored);
    // Telemetry is deliberately best-effort. A broken console/local logger
    // must never turn an otherwise valid semantic operation into a failure.
    try { this.#logger?.metric?.(stored); } catch { /* no-op */ }
    return stored;
  }

  measure(operation, dimensions = {}) {
    const startedAt = this.#now();
    return (result = {}) => this.record({
      operation,
      durationMs: Math.max(0, this.#now() - startedAt),
      ...dimensions,
      ...result,
    });
  }

  snapshot() {
    return structuredClone(this.#events);
  }

  clear() {
    this.#events.length = 0;
  }
}

export function normalizeProviderUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { nominalInputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null };
  }
  const finite = value => Number.isFinite(value) ? Number(value) : null;
  const nominalInputTokens = finite(usage.input_tokens ?? usage.prompt_tokens);
  const cachedInputTokens = finite(
    usage.cached_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens,
  );
  const explicitUncached = finite(usage.uncached_input_tokens);
  return {
    nominalInputTokens,
    cachedInputTokens,
    uncachedInputTokens: explicitUncached ?? (
      nominalInputTokens !== null && cachedInputTokens !== null
        ? Math.max(0, nominalInputTokens - cachedInputTokens)
        : null
    ),
    outputTokens: finite(usage.output_tokens ?? usage.completion_tokens),
  };
}

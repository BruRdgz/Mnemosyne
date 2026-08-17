function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function localDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function requestText(args) {
  const schema = args.jsonSchema?.promptValue ?? args.jsonSchema?.value ?? args.jsonSchema;
  const system = schema
    ? `${String(args.systemPrompt ?? '')}\n\n${EXTRACTION_JSON_MODE_INSTRUCTION}\nThe object must satisfy this locally validated schema:\n${JSON.stringify(schema)}`
    : String(args.systemPrompt ?? '');
  return [system, args.prompt].filter(Boolean).join('\n');
}

export class TokenLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TokenLimitError';
    this.code = 'token_limit';
    this.details = structuredClone(details);
  }
}

export class TokenGuard {
  #ledger;
  #settings;
  #metrics;
  #countTokens;
  #getChatId;
  #sessionSpentTokens = 0;
  #day = localDay();
  #dailySpentTokens = 0;
  #dailyLoaded = false;
  #reservedTokens = 0;
  #ledgerHealthy = true;

  constructor({ ledger = null, settings, metrics = null, countTokens, getChatId = () => null }) {
    this.#ledger = ledger;
    this.#settings = settings;
    this.#metrics = metrics;
    this.#countTokens = countTokens;
    this.#getChatId = getChatId;
  }

  status() {
    const sessionCap = finite(this.#settings.memorySessionTokenCap) ?? 0;
    const dailyCap = finite(this.#settings.memoryDailyTokenCap) ?? 0;
    return {
      sessionCap,
      dailyCap,
      sessionSpentTokens: this.#sessionSpentTokens,
      dailySpentTokens: this.#dailySpentTokens,
      reservedTokens: this.#reservedTokens,
      sessionRemainingTokens: sessionCap > 0 ? Math.max(0, sessionCap - this.#sessionSpentTokens - this.#reservedTokens) : null,
      dailyRemainingTokens: dailyCap > 0 ? Math.max(0, dailyCap - this.#dailySpentTokens - this.#reservedTokens) : null,
      dailyLoaded: this.#dailyLoaded,
      ledgerHealthy: this.#ledgerHealthy,
      day: this.#day,
    };
  }

  wrap(adapter) {
    if (!adapter?.generate) throw new TypeError('TokenGuard requires a generation adapter');
    return { generate: args => this.#generate(adapter, args) };
  }

  async #generate(adapter, args = {}) {
    await this.#ensureDaily();
    const estimatedInputTokens = finite(args.estimatedInputTokens) ?? await this.#safeCount(requestText(args));
    const outputCeiling = Math.max(0, Number(args.maxTokens) || 0);
    const projectedTokens = estimatedInputTokens + outputCeiling;
    this.#assertAvailable(projectedTokens);
    this.#reservedTokens += projectedTokens;
    let response;
    try {
      response = await adapter.generate(args);
    } finally {
      this.#reservedTokens = Math.max(0, this.#reservedTokens - projectedTokens);
    }

    const providerUsage = response?.usage ?? {};
    const measuredInput = finite(providerUsage.nominalInputTokens);
    const measuredOutput = finite(providerUsage.outputTokens);
    const outputTokens = measuredOutput ?? await this.#safeCount(response?.text ?? '');
    const usage = {
      nominalInputTokens: measuredInput ?? estimatedInputTokens,
      cachedInputTokens: measuredInput === null ? null : finite(providerUsage.cachedInputTokens),
      uncachedInputTokens: measuredInput === null ? estimatedInputTokens : finite(providerUsage.uncachedInputTokens),
      outputTokens,
    };
    const usageSource = measuredInput !== null && measuredOutput !== null ? 'provider' : 'estimated';
    const totalTokens = usage.nominalInputTokens + usage.outputTokens;
    this.#sessionSpentTokens += totalTokens;
    this.#dailySpentTokens += totalTokens;
    const entry = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      day: this.#day,
      timestamp: Date.now(),
      chatId: String(this.#getChatId?.() ?? ''),
      requestId: response?.requestId ?? null,
      model: response?.model ?? null,
      usage,
      usageSource,
      totalTokens,
      executionMode: 'live',
    };
    try {
      if ((finite(this.#settings.memoryDailyTokenCap) ?? 0) > 0 && typeof this.#ledger?.appendTokenLedger !== 'function') {
        throw new Error('Daily token ledger is unavailable');
      }
      await this.#ledger?.appendTokenLedger?.(entry);
      this.#ledgerHealthy = true;
    } catch (error) {
      this.#ledgerHealthy = false;
      this.#metrics?.record({ operation: 'token_ledger', status: 'write_failed', errorName: error?.name ?? 'Error' });
    }
    this.#metrics?.record({ operation: 'token_guard', status: 'spent', usageSource, totalTokens, sessionSpentTokens: this.#sessionSpentTokens, dailySpentTokens: this.#dailySpentTokens });
    return response;
  }

  async #ensureDaily() {
    const today = localDay();
    if (today !== this.#day) {
      this.#day = today;
      this.#dailySpentTokens = 0;
      this.#dailyLoaded = false;
      this.#ledgerHealthy = true;
    }
    if (this.#dailyLoaded) return;
    try {
      if ((finite(this.#settings.memoryDailyTokenCap) ?? 0) > 0 && typeof this.#ledger?.tokenLedgerForDay !== 'function') {
        throw new Error('Daily token ledger is unavailable');
      }
      const entries = await this.#ledger?.tokenLedgerForDay?.(this.#day) ?? [];
      this.#dailySpentTokens = entries
        .filter(entry => entry.executionMode === 'live')
        .reduce((sum, entry) => sum + (finite(entry.totalTokens) ?? 0), 0);
      this.#dailyLoaded = true;
      this.#ledgerHealthy = true;
      this.#metrics?.record({ operation: 'token_ledger', status: 'loaded', entryCount: entries.length, dailySpentTokens: this.#dailySpentTokens });
    } catch (error) {
      this.#ledgerHealthy = false;
      this.#metrics?.record({ operation: 'token_ledger', status: 'read_failed', errorName: error?.name ?? 'Error' });
      if ((finite(this.#settings.memoryDailyTokenCap) ?? 0) > 0) {
        throw new TokenLimitError('Daily token ledger is unavailable; live memory generation is paused safely.', { reason: 'ledger_unavailable' });
      }
    }
  }

  #assertAvailable(projectedTokens) {
    const sessionCap = finite(this.#settings.memorySessionTokenCap) ?? 0;
    const dailyCap = finite(this.#settings.memoryDailyTokenCap) ?? 0;
    if (dailyCap > 0 && !this.#ledgerHealthy) {
      throw new TokenLimitError('Daily token ledger is unhealthy; live memory generation is paused safely.', { reason: 'ledger_unavailable' });
    }
    if (sessionCap > 0 && this.#sessionSpentTokens + this.#reservedTokens + projectedTokens > sessionCap) {
      this.#metrics?.record({ operation: 'token_guard', status: 'blocked_session', projectedTokens, sessionSpentTokens: this.#sessionSpentTokens, sessionCap });
      throw new TokenLimitError('Mnemosyne session token cap would be exceeded.', { reason: 'session_cap', projectedTokens, spentTokens: this.#sessionSpentTokens, capTokens: sessionCap });
    }
    if (dailyCap > 0 && this.#dailySpentTokens + this.#reservedTokens + projectedTokens > dailyCap) {
      this.#metrics?.record({ operation: 'token_guard', status: 'blocked_daily', projectedTokens, dailySpentTokens: this.#dailySpentTokens, dailyCap });
      throw new TokenLimitError('Mnemosyne daily token cap would be exceeded.', { reason: 'daily_cap', projectedTokens, spentTokens: this.#dailySpentTokens, capTokens: dailyCap });
    }
  }

  async #safeCount(text) {
    try {
      const count = Number(await this.#countTokens(String(text ?? '')));
      if (Number.isFinite(count) && count >= 0) return count;
    } catch { /* deterministic character fallback below */ }
    return Math.ceil(String(text ?? '').length / 4);
  }
}

export { localDay };
import { EXTRACTION_JSON_MODE_INSTRUCTION } from '../extraction/request-compiler.js';

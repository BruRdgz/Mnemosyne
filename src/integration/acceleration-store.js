function safeStoreName(chatId) {
  const normalized = String(chatId).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
  return `chat_${normalized || 'unknown'}`;
}

export class AccelerationStore {
  #localforage;
  #instances = new Map();
  #globalInstance = null;

  constructor(localforage) {
    if (!localforage || typeof localforage.createInstance !== 'function') {
      throw new TypeError('localForage is required');
    }
    this.#localforage = localforage;
  }

  forChat(chatId) {
    const key = String(chatId);
    if (!this.#instances.has(key)) {
      this.#instances.set(key, this.#localforage.createInstance({
        name: 'Mnemosyne',
        storeName: safeStoreName(key),
      }));
    }
    return this.#instances.get(key);
  }

  global() {
    if (!this.#globalInstance) this.#globalInstance = this.#localforage.createInstance({ name: 'Mnemosyne', storeName: 'global_token_ledger' });
    return this.#globalInstance;
  }

  async appendTokenLedger(entry) {
    const store = this.global();
    const day = String(entry?.day ?? 'unknown');
    const id = String(entry?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const key = `token:${day}:${id}`;
    const existing = await store.getItem(key);
    if (existing !== null && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`Token ledger entry collision: ${key}`);
    if (existing === null) await store.setItem(key, structuredClone({ ...entry, id, day }));
    const indexKey = `token:${day}:index`;
    const index = await store.getItem(indexKey) ?? [];
    if (!index.includes(key)) await store.setItem(indexKey, [...index, key]);
    return { ref: key, entry: structuredClone({ ...entry, id, day }) };
  }

  async tokenLedgerForDay(day) {
    const store = this.global();
    const prefix = `token:${String(day)}:`;
    const indexKey = `${prefix}index`;
    const indexed = await store.getItem(indexKey) ?? [];
    const discovered = typeof store.keys === 'function' ? (await store.keys()).filter(key => key.startsWith(prefix) && key !== indexKey) : [];
    const entries = [];
    for (const key of [...new Set([...indexed, ...discovered])]) {
      const value = await store.getItem(key);
      if (value && typeof value === 'object') entries.push(structuredClone(value));
    }
    return entries;
  }

  async smoke(chatId) {
    const store = this.forChat(chatId);
    const key = '__mnemosyne_smoke__';
    const value = { ok: true, at: Date.now() };
    await store.setItem(key, value);
    const loaded = await store.getItem(key);
    await store.removeItem(key);
    return Boolean(loaded?.ok);
  }

  async putRebuildAttempt(chatId, sessionId, segmentId, attemptNumber, value) {
    const store = this.forChat(chatId);
    let resolvedAttemptNumber = attemptNumber;
    let key;
    while (true) {
      key = `rebuild:${sessionId}:${segmentId}:${resolvedAttemptNumber}`;
      const existing = await store.getItem(key);
      if (existing === null) break;
      if (JSON.stringify(existing) === JSON.stringify(value)) return { ref: key, attemptNumber: resolvedAttemptNumber };
      resolvedAttemptNumber += 1;
    }
    await store.setItem(key, structuredClone(value));
    const indexKey = `rebuild:${sessionId}:index`;
    const index = await store.getItem(indexKey) ?? [];
    if (!index.includes(key)) await store.setItem(indexKey, [...index, key]);
    return { ref: key, attemptNumber: resolvedAttemptNumber };
  }

  async getRebuildAttempt(chatId, ref) {
    return this.forChat(chatId).getItem(ref);
  }

  async latestRebuildAttempt(chatId, sessionId, segmentId) {
    const store = this.forChat(chatId);
    const prefix = `rebuild:${sessionId}:${segmentId}:`;
    const keys = typeof store.keys === 'function' ? await store.keys() : [];
    const candidates = keys
      .filter(key => key.startsWith(prefix) && !key.endsWith(':index'))
      .map(key => ({ key, attempt: Number(key.slice(prefix.length)) }))
      .filter(item => Number.isInteger(item.attempt))
      .sort((a, b) => b.attempt - a.attempt);
    if (!candidates.length) return null;
    return { ref: candidates[0].key, value: await store.getItem(candidates[0].key), attempt: candidates[0].attempt };
  }

  async putCompactionAttempt(chatId, segmentId, attemptNumber, value) {
    const store = this.forChat(chatId);
    let resolvedAttemptNumber = Math.max(1, Number(attemptNumber) || 1);
    let key;
    while (true) {
      key = `compaction:${segmentId}:${resolvedAttemptNumber}`;
      const existing = await store.getItem(key);
      if (existing === null) break;
      if (JSON.stringify(existing) === JSON.stringify(value)) return { ref: key, attemptNumber: resolvedAttemptNumber };
      resolvedAttemptNumber += 1;
    }
    await store.setItem(key, structuredClone(value));
    const indexKey = 'compaction:index';
    const index = await store.getItem(indexKey) ?? [];
    if (!index.includes(key)) await store.setItem(indexKey, [...index, key]);
    return { ref: key, attemptNumber: resolvedAttemptNumber };
  }

  async getCompactionAttempt(chatId, ref) {
    return this.forChat(chatId).getItem(ref);
  }

  async getTokenCache(chatId) {
    const value = await this.forChat(chatId).getItem('acceleration:token-cache:v1');
    return value?.version === 1 && Array.isArray(value.entries) ? structuredClone(value) : null;
  }

  async putTokenCache(chatId, { tokenizerKeys = [], entries = [] } = {}) {
    const value = { version: 1, tokenizerKeys: [...new Set(tokenizerKeys.map(String))], entries: structuredClone(entries), updatedAt: Date.now() };
    await this.forChat(chatId).setItem('acceleration:token-cache:v1', value);
    return structuredClone(value);
  }

  async getLexicalIndex(chatId) {
    const value = await this.forChat(chatId).getItem('acceleration:lexical-index:v1');
    return value?.version === 1 && typeof value.fingerprint === 'string' && Array.isArray(value.documents) ? structuredClone(value) : null;
  }

  async putLexicalIndex(chatId, { fingerprint, documents }) {
    const value = { version: 1, fingerprint: String(fingerprint), documents: structuredClone(documents), updatedAt: Date.now() };
    await this.forChat(chatId).setItem('acceleration:lexical-index:v1', value);
    return structuredClone(value);
  }

  async getReplayCheckpoint(chatId) {
    const value = await this.forChat(chatId).getItem('acceleration:replay-checkpoint:v1');
    return value?.version === 1 && value.checkpoint && typeof value.checkpoint === 'object' ? structuredClone(value) : null;
  }

  async putReplayCheckpoint(chatId, checkpoint) {
    const value = { version: 1, checkpoint: structuredClone(checkpoint), updatedAt: Date.now() };
    await this.forChat(chatId).setItem('acceleration:replay-checkpoint:v1', value);
    return structuredClone(value);
  }

  async importRebuildAttempts(chatId, sessionId, attempts = []) {
    if (!Array.isArray(attempts)) throw new TypeError('Replay raw attempts must be an array');
    const store = this.forChat(chatId);
    const prefix = `rebuild:${sessionId}:`;
    const indexKey = `${prefix}index`;
    const index = await store.getItem(indexKey) ?? [];
    for (const entry of attempts) {
      const ref = entry?.ref ?? entry?.key;
      if (!entry || typeof ref !== 'string' || !ref.startsWith(prefix) || ref === indexKey || !entry.value || typeof entry.value !== 'object') {
        throw new TypeError('Replay raw attempt reference is invalid');
      }
      const existing = await store.getItem(ref);
      if (existing !== null && JSON.stringify(existing) !== JSON.stringify(entry.value)) {
        throw new Error(`Replay raw attempt already exists with different content: ${ref}`);
      }
      if (existing === null) await store.setItem(ref, structuredClone(entry.value));
      if (!index.includes(ref)) index.push(ref);
    }
    await store.setItem(indexKey, index);
    return attempts.length;
  }

  async exportRebuildAttempts(chatId, sessionId) {
    const store = this.forChat(chatId);
    const indexed = await store.getItem(`rebuild:${sessionId}:index`) ?? [];
    const discovered = typeof store.keys === 'function'
      ? (await store.keys()).filter(key => key.startsWith(`rebuild:${sessionId}:`) && !key.endsWith(':index'))
      : [];
    const keys = [...new Set([...indexed, ...discovered])];
    const attempts = [];
    for (const key of keys) attempts.push({ ref: key, value: await store.getItem(key) });
    return attempts;
  }

  async deleteRebuildAttempts(chatId, sessionId) {
    const store = this.forChat(chatId);
    const indexKey = `rebuild:${sessionId}:index`;
    const indexed = await store.getItem(indexKey) ?? [];
    const discovered = typeof store.keys === 'function'
      ? (await store.keys()).filter(key => key.startsWith(`rebuild:${sessionId}:`) && key !== indexKey)
      : [];
    const keys = [...new Set([...indexed, ...discovered])];
    for (const key of keys) await store.removeItem(key);
    await store.removeItem(indexKey);
    return keys.length;
  }
}

export { safeStoreName };

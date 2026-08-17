import { createMessageSourceRef } from '../domain/fingerprint.js';

export class TokenCountCache {
  #entries = new Map();
  #metrics;

  constructor({ metrics = null, initialEntries = [] } = {}) {
    this.#metrics = metrics;
    for (const entry of initialEntries) this.#entries.set(entry.key, structuredClone(entry));
  }

  key(fingerprint, tokenizerKey) {
    return `${String(tokenizerKey)}:${String(fingerprint)}`;
  }

  get(fingerprint, tokenizerKey) {
    const entry = this.#entries.get(this.key(fingerprint, tokenizerKey));
    return entry ? entry.tokenCount : null;
  }

  set(fingerprint, tokenizerKey, tokenCount) {
    if (!Number.isInteger(tokenCount) || tokenCount < 0) throw new TypeError('tokenCount must be a non-negative integer');
    const key = this.key(fingerprint, tokenizerKey);
    this.#entries.set(key, { key, fingerprint, tokenizerKey: String(tokenizerKey), tokenCount });
    return tokenCount;
  }

  async count(message, messageIndex, { tokenizerKey, countTokens }) {
    const source = createMessageSourceRef(message, messageIndex);
    const cached = this.get(source.messageFingerprint, tokenizerKey);
    if (cached !== null) {
      this.#metrics?.record({
        operation: 'token_count', fingerprint: source.messageFingerprint,
        tokenizerKey: String(tokenizerKey), tokenCount: cached, cacheStatus: 'hit',
      });
      return { source, tokenCount: cached, cacheStatus: 'hit' };
    }
    const finish = this.#metrics?.measure('token_count', {
      fingerprint: source.messageFingerprint,
      tokenizerKey: String(tokenizerKey),
      cacheStatus: 'miss',
    });
    const tokenCount = await countTokens(String(message.text ?? message.mes ?? ''));
    this.set(source.messageFingerprint, tokenizerKey, tokenCount);
    finish?.({ status: 'success', tokenCount });
    return { source, tokenCount, cacheStatus: 'miss' };
  }

  async countAll(messages, adapter) {
    const results = [];
    for (let index = 0; index < messages.length; index += 1) {
      results.push(await this.count(messages[index], index, adapter));
    }
    return results;
  }

  serialize() {
    return [...this.#entries.values()].map(entry => structuredClone(entry));
  }

  get size() {
    return this.#entries.size;
  }
}

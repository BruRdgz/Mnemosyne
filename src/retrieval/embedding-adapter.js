import { fingerprintValue, stableStringify } from '../domain/fingerprint.js';

export class EmbeddingCache {
  #entries = new Map();

  key({ model, config = {}, artifactFingerprint }) {
    return fingerprintValue({ model, config, artifactFingerprint }, 'embedding-cache');
  }

  get(identity) { return structuredClone(this.#entries.get(this.key(identity)) ?? null); }
  set(identity, vector) { this.#entries.set(this.key(identity), [...vector]); }
  clear() { this.#entries.clear(); }
  get size() { return this.#entries.size; }
  serialize() { return [...this.#entries].map(([key, vector]) => [key, [...vector]]); }
  hydrate(entries) { this.#entries = new Map(entries.map(([key, vector]) => [key, [...vector]])); }
}

export class EmbeddingAdapter {
  #backend;
  #cache;
  #metrics;
  #model;
  #config;

  constructor({ backend = null, cache = new EmbeddingCache(), metrics = null, model = 'default', config = {} } = {}) {
    this.#backend = backend;
    this.#cache = cache;
    this.#metrics = metrics;
    this.#model = model;
    this.#config = structuredClone(config);
  }

  get available() { return typeof this.#backend === 'function'; }
  get identity() { return { model: this.#model, configFingerprint: fingerprintValue(this.#config, 'embedding-config') }; }

  async embedArtifact({ fingerprint, text }) {
    return this.#embed({ artifactFingerprint: fingerprint, text, cacheable: true, kind: 'artifact' });
  }

  async embedQuery(query) {
    const normalized = typeof query === 'string' ? query : stableStringify(query);
    return this.#embed({ artifactFingerprint: fingerprintValue(normalized, 'retrieval-query'), text: normalized, cacheable: false, kind: 'query' });
  }

  async #embed({ artifactFingerprint, text, cacheable, kind }) {
    if (!this.available) return null;
    const identity = { model: this.#model, config: this.#config, artifactFingerprint };
    if (cacheable) {
      const cached = this.#cache.get(identity);
      if (cached) {
        this.#metrics?.record({ operation: 'embedding_cache', status: 'hit', kind, modelFingerprint: fingerprintValue(this.#model, 'embedding-model') });
        return cached;
      }
    }
    const finish = this.#metrics?.measure('embedding_request', { kind, modelFingerprint: fingerprintValue(this.#model, 'embedding-model') });
    try {
      const vector = await this.#backend(text, { model: this.#model, config: structuredClone(this.#config) });
      if (!Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value))) throw new TypeError('Embedding backend returned an invalid vector');
      if (cacheable) this.#cache.set(identity, vector);
      finish?.({ status: 'success', dimensions: vector.length });
      return [...vector];
    } catch {
      finish?.({ status: 'failure', dimensions: 0 });
      return null;
    }
  }
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

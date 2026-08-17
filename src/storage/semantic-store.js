import { SCHEMA_VERSION, validateEpisodeSummary, validateMemorySegment, validateRegisterEnvelope } from '../domain/schema.js';
import { ENVELOPE_VERSION } from '../core/constants.js';
import { validateRebuildSession } from '../rebuild/rebuild-session.js';

export function createPortableEnvelope(chatId) {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    chatId: String(chatId),
    segments: [],
    entities: [],
    registers: [],
    conflicts: [],
    checkpoints: [],
    rebuildSessions: [],
    preferences: {},
    updatedAt: Date.now(),
  };
}

export class SemanticStore {
  #adapter;
  #chatId;
  #data;
  #revision = 0;

  constructor({ adapter, chatId }) {
    if (!adapter?.readPortableMemory || !adapter?.writePortableMemory) throw new TypeError('Portable metadata adapter is required');
    this.#adapter = adapter;
    this.#chatId = String(chatId);
    this.#data = createPortableEnvelope(this.#chatId);
  }

  async load() {
    const existing = await this.#adapter.readPortableMemory();
    if (!existing) return this.snapshot();
    if (existing.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported semantic schema version: ${existing.schemaVersion}`);
    if (String(existing.chatId ?? this.#chatId) !== this.#chatId) throw new Error('Portable memory belongs to a different chat');
    if (!Array.isArray(existing.segments)) throw new Error('Portable segment list is invalid');
    for (const segment of existing.segments) validateMemorySegment(segment, { throwOnError: true });
    for (const session of existing.rebuildSessions ?? []) validateRebuildSession(session, { expectedChatId: this.#chatId });
    const migrated = existing.envelopeVersion !== ENVELOPE_VERSION;
    const next = { ...createPortableEnvelope(this.#chatId), ...structuredClone(existing), envelopeVersion: ENVELOPE_VERSION, rebuildSessions: structuredClone(existing.rebuildSessions ?? []), chatId: this.#chatId };
    if (migrated) await this.#persist(next);
    else {
      this.#data = next;
      this.#revision += 1;
    }
    return this.snapshot();
  }

  revision() { return this.#revision; }

  async save() {
    await this.#persist(this.#data);
  }

  async commitSegment(segment, { replaceManual = false } = {}) {
    const validated = validateMemorySegment(segment, { throwOnError: true }).value;
    const next = this.snapshot();
    const index = next.segments.findIndex(item => item.id === validated.id);
    if (index >= 0) {
      const current = next.segments[index];
      if (current.source.rangeFingerprint === validated.source.rangeFingerprint && JSON.stringify(current) === JSON.stringify(validated)) return false;
      if (current.manuallyEdited && !replaceManual) return false;
      next.segments[index] = structuredClone(validated);
    } else {
      next.segments.push(structuredClone(validated));
    }
    next.segments.sort((a, b) => a.source.first.messageIndex - b.source.first.messageIndex);
    await this.#persist(next);
    return true;
  }

  async editSynopsis(id, synopsis) {
    const next = this.snapshot();
    const segment = this.#requireFrom(next, id);
    if (segment.status !== 'valid' || !segment.summary) throw new Error('Only valid segment memory can be edited');
    const updatedSummary = { ...segment.summary, synopsis: String(synopsis).trim() };
    validateEpisodeSummary(updatedSummary, { throwOnError: true });
    Object.assign(segment, {
      summary: updatedSummary,
      manuallyEdited: true,
      updatedAt: Date.now(),
      manualProvenance: { kind: 'manual', editedAt: Date.now(), sourceFingerprint: segment.source.rangeFingerprint },
    });
    await this.#persist(next);
    return structuredClone(segment);
  }

  /**
   * Retire one active commitment without touching the linked raw messages.
   *
   * Commitments are part of a segment's normalized candidate, so the edit is
   * deliberately recorded on that candidate (and marked manual) instead of
   * deleting the record.  Replay will see the explicit `obsolete` transition
   * and the state projector will stop injecting it.  Keeping the original
   * source range and the prior evidence makes this operation auditable and
   * lets exports preserve what the model originally produced.
   */
  async retireCommitment(id, commitmentIndexOrId) {
    const next = this.snapshot();
    const segment = this.#requireFrom(next, id);
    if (segment.status !== 'valid' || !segment.summary) throw new Error('Only valid segment memory can be edited');
    const commitments = Array.isArray(segment.summary.commitments) ? segment.summary.commitments : [];
    const numericIndex = typeof commitmentIndexOrId === 'number'
      ? commitmentIndexOrId
      : (typeof commitmentIndexOrId === 'string' && /^\d+$/.test(commitmentIndexOrId.trim()) ? Number(commitmentIndexOrId) : NaN);
    const index = Number.isInteger(numericIndex) && numericIndex >= 0
      ? numericIndex
      : commitments.findIndex(item => item?.id === String(commitmentIndexOrId));
    if (!Number.isInteger(index) || index < 0) throw new TypeError('Commitment index or id is required');
    const commitment = commitments[index];
    if (!commitment) throw new Error(`Unknown commitment ${index} in segment ${id}`);
    if (!['made', 'active', 'unknown'].includes(commitment.transition)) {
      return structuredClone(segment);
    }
    const editedAt = Date.now();
    const previousTransition = commitment.transition;
    commitment.transition = 'obsolete';
    validateEpisodeSummary(segment.summary, { throwOnError: true });
    const previousProvenance = segment.manualProvenance && typeof segment.manualProvenance === 'object'
      ? segment.manualProvenance
      : {};
    const previousRetirements = Array.isArray(previousProvenance.commitmentRetirements)
      ? previousProvenance.commitmentRetirements
      : [];
    Object.assign(segment, {
      manuallyEdited: true,
      updatedAt: editedAt,
      manualProvenance: {
        ...structuredClone(previousProvenance),
        kind: previousProvenance.kind ?? 'manual',
        lastAction: 'retire_commitment',
        editedAt,
        sourceFingerprint: segment.source.rangeFingerprint,
        commitmentRetirements: [
          ...previousRetirements,
          {
            index,
            id: commitment.id ?? null,
            actor: commitment.actor,
            toward: commitment.toward ?? null,
            content: commitment.content,
            previousTransition,
            evidence: commitment.evidence,
            retiredAt: editedAt,
          },
        ],
      },
    });
    await this.#persist(next);
    return structuredClone(segment);
  }

  async setPinned(id, pinned) {
    const next = this.snapshot();
    const segment = this.#requireFrom(next, id);
    segment.pinned = Boolean(pinned);
    segment.updatedAt = Date.now();
    await this.#persist(next);
    return structuredClone(segment);
  }

  async setExcluded(id, excluded) {
    const next = this.snapshot();
    const segment = this.#requireFrom(next, id);
    segment.status = excluded ? 'excluded' : (segment.summary ? 'valid' : 'pending');
    segment.updatedAt = Date.now();
    await this.#persist(next);
    return structuredClone(segment);
  }

  async prepareRegeneration(id) {
    const next = this.snapshot();
    const segment = this.#requireFrom(next, id);
    segment.status = 'pending';
    segment.summary = null;
    segment.manuallyEdited = false;
    delete segment.manualProvenance;
    segment.updatedAt = Date.now();
    await this.#persist(next);
    return structuredClone(segment);
  }

  get(id) {
    const segment = this.#data.segments.find(item => item.id === id);
    return segment ? structuredClone(segment) : null;
  }

  timeline({ includeExcluded = true } = {}) {
    return this.#data.segments
      .filter(segment => includeExcluded || segment.status !== 'excluded')
      .map(segment => structuredClone(segment));
  }

  sourceFor(id, activeMessages) {
    const segment = this.#require(id);
    return structuredClone(activeMessages.slice(segment.source.first.messageIndex, segment.source.last.messageIndex + 1));
  }

  snapshot() {
    return structuredClone(this.#data);
  }

  async replaceEnvelope(envelope) {
    if (envelope.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported semantic schema version: ${envelope.schemaVersion}`);
    if (String(envelope.chatId) !== this.#chatId) throw new Error('Portable memory belongs to a different chat');
    if (!Array.isArray(envelope.segments)) throw new Error('Portable segment list is invalid');
    for (const segment of envelope.segments) validateMemorySegment(segment, { throwOnError: true });
    for (const session of envelope.rebuildSessions ?? []) validateRebuildSession(session, { expectedChatId: this.#chatId });
    const next = { ...createPortableEnvelope(this.#chatId), ...structuredClone(envelope), envelopeVersion: ENVELOPE_VERSION, rebuildSessions: structuredClone(envelope.rebuildSessions ?? []), chatId: this.#chatId };
    await this.#persist(next);
    return this.snapshot();
  }

  async replaceSegments(segments) {
    return this.replaceEnvelope({ ...this.snapshot(), segments: structuredClone(segments) });
  }

  async replaceMaterialized({ entities = this.#data.entities, registers = this.#data.registers } = {}) {
    if (!Array.isArray(entities) || !Array.isArray(registers)) throw new TypeError('Materialized entities and registers must be arrays');
    for (const register of registers) validateRegisterEnvelope(register, { throwOnError: true });
    const next = this.snapshot();
    next.entities = structuredClone(entities);
    next.registers = structuredClone(registers);
    await this.#persist(next);
    return this.snapshot();
  }

  async setPreferences(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Preference patch must be an object');
    const next = this.snapshot();
    next.preferences = { ...(next.preferences ?? {}), ...structuredClone(patch) };
    await this.#persist(next);
    return structuredClone(next.preferences);
  }

  preferences() {
    return structuredClone(this.#data.preferences ?? {});
  }

  rebuildSessions() {
    return structuredClone(this.#data.rebuildSessions ?? []);
  }

  getRebuildSession(id) {
    const session = (this.#data.rebuildSessions ?? []).find(value => value.id === id);
    return session ? structuredClone(session) : null;
  }

  async upsertRebuildSession(session) {
    const validated = validateRebuildSession(session, { expectedChatId: this.#chatId });
    const next = this.snapshot();
    next.rebuildSessions ??= [];
    const index = next.rebuildSessions.findIndex(value => value.id === validated.id);
    if (index >= 0) next.rebuildSessions[index] = structuredClone(validated);
    else next.rebuildSessions.push(structuredClone(validated));
    await this.#persist(next);
    return structuredClone(validated);
  }

  async deleteRebuildSession(id) {
    const next = this.snapshot();
    const before = next.rebuildSessions?.length ?? 0;
    next.rebuildSessions = (next.rebuildSessions ?? []).filter(session => session.id !== id);
    if (next.rebuildSessions.length === before) return false;
    await this.#persist(next);
    return true;
  }

  #require(id) {
    return this.#requireFrom(this.#data, id);
  }

  #requireFrom(data, id) {
    const segment = data.segments.find(item => item.id === id);
    if (!segment) throw new Error(`Unknown segment: ${id}`);
    return segment;
  }

  async #persist(data) {
    const next = structuredClone(data);
    next.updatedAt = Date.now();
    await this.#adapter.writePortableMemory(structuredClone(next));
    this.#data = next;
    this.#revision += 1;
  }
}

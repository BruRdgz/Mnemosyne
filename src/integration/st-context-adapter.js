import { METADATA_KEY, PROMPT_KEY, ST_EXTENSION_PROMPT } from '../core/constants.js';

export class StContextAdapter {
  #getContext;
  #saveMetadataDebounced;

  constructor({ getContext, saveMetadataDebounced = null }) {
    if (typeof getContext !== 'function') throw new TypeError('getContext is required');
    this.#getContext = getContext;
    this.#saveMetadataDebounced = saveMetadataDebounced;
  }

  context() {
    const context = this.#getContext();
    if (!context || typeof context !== 'object') throw new Error('SillyTavern context is unavailable');
    return context;
  }

  chatId() {
    const context = this.context();
    const id = context.chatId ?? context.getCurrentChatId?.();
    if (id === undefined || id === null || id === '') throw new Error('No active SillyTavern chat identity');
    return String(id);
  }

  profileIdentity() {
    const context = this.context();
    const character = context.characterId ?? context.this_chid ?? context.character?.id ?? context.character?.avatar ?? null;
    const group = context.groupId ?? context.group_id ?? context.groupChatId ?? context.group?.id ?? null;
    return { chatId: this.chatId(), characterId: character === null || character === undefined ? null : String(character), groupId: group === null || group === undefined ? null : String(group) };
  }

  /**
   * Returns the prospective assistant name selected by SillyTavern for the
   * current generation. In group chats ST switches characterId/name2 before
   * running extension interceptors, so this is more reliable than inferring
   * the speaker from the last already-rendered assistant message.
   */
  activeCharacterName() {
    const context = this.context();
    const direct = String(context.name2 ?? context.characterName ?? '').trim();
    if (direct) return direct;
    const id = context.characterId ?? context.this_chid;
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const hasId = id !== null && id !== undefined && String(id).trim() !== '';
    const numeric = hasId ? Number(id) : Number.NaN;
    const candidate = Number.isInteger(numeric) ? characters[numeric] : hasId ? characters.find(item => String(item?.avatar ?? '') === String(id)) : null;
    return String(candidate?.name ?? '').trim() || null;
  }

  sourceMessages() {
    const chat = this.context().chat;
    if (!Array.isArray(chat)) return [];
    return chat.map((message, index) => ({
      index,
      role: message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'),
      name: String(message.name ?? ''),
      text: String(message.mes ?? ''),
      hidden: Boolean(message.is_system || message.extra?.type === 'system'),
      swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : 0,
      sendDate: message.send_date ?? null,
      original: message,
    }));
  }

  async countTokens(text) {
    const count = await this.context().getTokenCountAsync?.(String(text));
    if (!Number.isFinite(count) || count < 0) throw new Error('SillyTavern tokenizer returned an invalid count');
    return Number(count);
  }

  tokenizerKey() {
    const context = this.context();
    let model = 'unknown';
    try { model = String(context.getTokenizerModel?.() ?? 'unknown'); } catch { /* tokenizer fallback remains isolated */ }
    return `${String(context.mainApi ?? 'unknown')}:${model}`;
  }

  extensionPromptEntries() {
    const source = this.context().extensionPrompts;
    if (!source || typeof source !== 'object') return null;
    const entries = source instanceof Map ? [...source.entries()] : Object.entries(source);
    // Do not clone ST's optional filter functions. The budget observer is
    // intentionally passive and only needs public value/placement fields.
    return entries.map(([key, value]) => ({
      key: String(key),
      value: typeof value === 'string' ? value : String(value?.value ?? value?.text ?? value?.content ?? ''),
      position: Number.isFinite(Number(value?.position)) ? Number(value.position) : null,
      depth: Number.isFinite(Number(value?.depth)) ? Number(value.depth) : null,
      scan: typeof value?.scan === 'boolean' ? value.scan : null,
      role: Number.isFinite(Number(value?.role)) ? Number(value.role) : null,
    }));
  }

  /**
   * Read an optional, explicitly public prompt-token breakdown. ST 1.18 does
   * not currently provide one; keeping this capability at the adapter edge
   * lets newer builds expose exact card/lorebook/example accounting without
   * importing Prompt Manager internals. A failing or malformed hook is
   * treated as unavailable and the runtime keeps its conservative reserve.
   */
  async publicPromptTokenBreakdown() {
    const context = this.context();
    const getter = context.getPublicPromptTokenBreakdown ?? context.getPromptTokenBreakdown;
    try {
      if (typeof getter === 'function') return structuredClone(await getter.call(context));
      const value = context.publicPromptTokenBreakdown ?? context.promptTokenBreakdown;
      return value && typeof value === 'object' ? structuredClone(value) : null;
    } catch {
      return null;
    }
  }

  readPortableMemory() {
    return structuredClone(this.context().chatMetadata?.[METADATA_KEY] ?? null);
  }

  async writePortableMemory(value) {
    const context = this.context();
    if (!context.chatMetadata) throw new Error('SillyTavern chatMetadata is unavailable');
    const previous = Object.hasOwn(context.chatMetadata, METADATA_KEY)
      ? structuredClone(context.chatMetadata[METADATA_KEY])
      : undefined;
    const hadPrevious = Object.hasOwn(context.chatMetadata, METADATA_KEY);
    context.chatMetadata[METADATA_KEY] = structuredClone(value);
    try {
      if (typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
      } else if (typeof this.#saveMetadataDebounced === 'function') {
        this.#saveMetadataDebounced();
      } else {
        throw new Error('No durable SillyTavern metadata save route is available');
      }
    } catch (error) {
      // ST exposes chatMetadata as a mutable object. Restore the previous
      // value when its durable save route rejects, so a failed checkpoint does
      // not publish a phantom candidate to the live context either.
      if (hadPrevious) context.chatMetadata[METADATA_KEY] = previous;
      else delete context.chatMetadata[METADATA_KEY];
      throw error;
    }
  }

  setContextInjection(text, {
    position = ST_EXTENSION_PROMPT.position.IN_CHAT,
    depth = 0,
    scan = false,
    role = ST_EXTENSION_PROMPT.role.SYSTEM,
  } = {}) {
    const context = this.context();
    if (typeof context.setExtensionPrompt !== 'function') {
      throw new Error('SillyTavern setExtensionPrompt is unavailable');
    }
    if (!Object.values(ST_EXTENSION_PROMPT.position).includes(Number(position))) throw new RangeError('Invalid SillyTavern extension prompt position');
    if (!Number.isInteger(Number(depth)) || Number(depth) < 0) throw new RangeError('Invalid SillyTavern extension prompt depth');
    if (!Object.values(ST_EXTENSION_PROMPT.role).includes(Number(role))) throw new RangeError('Invalid SillyTavern extension prompt role');
    context.setExtensionPrompt(PROMPT_KEY, String(text), Number(position), Number(depth), Boolean(scan), Number(role));
  }

  clearContextInjection() {
    this.setContextInjection('');
  }

  focusSourceRange(firstIndex, lastIndex = firstIndex) {
    if (typeof document === 'undefined') return false;
    const first = Number(firstIndex);
    const last = Number(lastIndex);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) return false;
    const target = document.querySelector(`#chat .mes[mesid="${first}"]`);
    if (!target) return false;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    target.classList.add('mnemosyne-source-focus');
    target.style.outline = '2px solid var(--SmartThemeQuoteColor, #d9b44a)';
    setTimeout(() => { target.classList.remove('mnemosyne-source-focus'); target.style.removeProperty('outline'); }, 1800);
    return true;
  }

  ignoreSymbol() {
    const symbol = this.context().symbols?.ignore;
    if (typeof symbol !== 'symbol') throw new Error('SillyTavern ignore symbol is unavailable');
    return symbol;
  }
}

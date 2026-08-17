const EVENT_KEYS = Object.freeze({
  edited: 'MESSAGE_EDITED',
  deleted: 'MESSAGE_DELETED',
  swiped: 'MESSAGE_SWIPED',
  sent: 'MESSAGE_SENT',
  received: 'MESSAGE_RECEIVED',
  chatChanged: 'CHAT_CHANGED',
});

const RENDER_REPAIR_EVENT_KEYS = Object.freeze([
  'USER_MESSAGE_RENDERED',
  'CHARACTER_MESSAGE_RENDERED',
  'MESSAGE_UPDATED',
  'MESSAGE_SWIPED',
  'MESSAGE_DELETED',
  'CHAT_CHANGED',
]);

export function normalizeRenderedMessageIndex(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isRenderedMessage(node) {
  if (!node) return false;
  if (typeof node.matches === 'function') return node.matches('.mes[mesid]');
  const classes = String(node.className ?? '').split(/\s+/).filter(Boolean);
  return classes.includes('mes') && node.getAttribute?.('mesid') !== null;
}

function renderedMessages(chat) {
  // SillyTavern appends message wrappers directly under #chat.  Walking the
  // whole subtree here is needlessly expensive because each message can
  // contain hundreds of formatted text nodes.  Keep a defensive fallback for
  // alternate renderers that wrap messages in another container.
  const direct = Array.from(chat?.children ?? []).filter(isRenderedMessage);
  if (direct.length) return direct;
  return typeof chat?.querySelectorAll === 'function' ? [...chat.querySelectorAll('.mes[mesid]')] : [];
}

export class StEventAdapter {
  #getContext;
  #logger;
  #subscriptions = [];

  constructor({ getContext, logger = null }) {
    this.#getContext = getContext;
    this.#logger = logger;
  }

  attach(handler) {
    const context = this.#getContext();
    const source = context.eventSource;
    const types = context.eventTypes ?? context.event_types;
    if (!source || !types) throw new Error('SillyTavern event API is unavailable');

    for (const [kind, eventKey] of Object.entries(EVENT_KEYS)) {
      const eventName = types[eventKey];
      if (!eventName) continue;
      const listener = payload => handler(this.normalize(kind, payload));
      source.on(eventName, listener);
      this.#subscriptions.push(() => source.removeListener(eventName, listener));
    }
    return () => this.dispose();
  }

  attachPromptAudit(handler) {
    const context = this.#getContext();
    const source = context.eventSource;
    const types = context.eventTypes ?? context.event_types;
    const eventName = types?.CHAT_COMPLETION_PROMPT_READY;
    if (!source || !eventName) return () => {};
    // ST awaits event listeners sequentially. Deferring one task observes the
    // shared event payload after every other prompt-ready listener has had the
    // opportunity to mutate it, without delaying or changing the provider call.
    const listener = payload => { setTimeout(() => handler(payload ?? {}), 0); };
    source.on(eventName, listener);
    source.makeLast?.(eventName, listener);
    const unsubscribe = () => source.removeListener(eventName, listener);
    this.#subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * Adds an ephemeral, read-only repair affordance to rendered ST messages.
   * The button is deliberately DOM-only: it never edits the message object or
   * writes chat metadata. Eligibility is supplied by the runtime so stale,
   * excluded, and manually edited candidates are not presented as repairable.
   */
  attachRenderedMessageRepair({ canRepair = () => false, onRepair = async () => {} } = {}) {
    if (typeof document === 'undefined') return () => {};
    const context = this.#getContext();
    const source = context?.eventSource;
    const types = context?.eventTypes ?? context?.event_types;
    const chat = document.querySelector('#chat');
    if (!source || typeof source.on !== 'function' || !chat) return () => {};
    const render = () => {
      const messages = renderedMessages(chat);
      for (const message of messages) {
        const index = normalizeRenderedMessageIndex(message.getAttribute?.('mesid') ?? message.dataset?.mesid);
        if (index === null) continue;
        let eligible = false;
        try { eligible = Boolean(canRepair(index)); } catch { eligible = false; }
        const existing = message.querySelector?.('[data-mnemosyne-message-repair]');
        if (!eligible) {
          existing?.remove?.();
          continue;
        }
        if (existing) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mes_button mnemosyne-message-repair';
        button.dataset.mnemosyneMessageRepair = String(index);
        button.title = 'Repair Mnemosyne memory for this message range';
        button.setAttribute('aria-label', 'Repair Mnemosyne memory');
        button.textContent = 'Repair memory';
        const host = message.querySelector?.('.extraMesButtons, .mes_buttons') ?? message;
        host.append?.(button);
      }
    };

    const click = event => {
      const button = event.target?.closest?.('[data-mnemosyne-message-repair]');
      if (!button || !chat.contains?.(button)) return;
      const index = normalizeRenderedMessageIndex(button.dataset?.mnemosyneMessageRepair);
      if (index === null) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      Promise.resolve(onRepair(index)).catch(() => {});
    };
    // ST can append a long chat one message at a time.  Rendering the entire
    // chat synchronously for every MutationObserver delivery turns that into
    // O(n²) work and makes opening large chats look frozen.  Event-driven
    // refreshes stay microtask-fast for existing callers/tests; DOM mutations
    // are coalesced onto the next macrotask so a burst is scanned once.
    let renderScheduled = false;
    let renderTimer = null;
    const scheduleRender = ({ defer = true } = {}) => {
      // Reset the deferred timer for each mutation.  ST may hydrate a chat
      // over several tasks; a small debounce prevents a full-chat scan after
      // every task while still making the affordance appear promptly.
      if (defer && renderTimer !== null) clearTimeout(renderTimer);
      if (renderScheduled && (!defer || renderTimer === null)) return;
      renderScheduled = true;
      const run = () => {
        renderScheduled = false;
        renderTimer = null;
        render();
      };
      if (defer) renderTimer = setTimeout(run, 16);
      else queueMicrotask(run);
    };
    chat.addEventListener?.('click', click);
    const subscriptions = [];
    for (const key of RENDER_REPAIR_EVENT_KEYS) {
      const eventName = types?.[key];
      if (!eventName) continue;
      const listener = () => { scheduleRender({ defer: false }); };
      source.on(eventName, listener);
      subscriptions.push(() => source.removeListener?.(eventName, listener));
    }
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => scheduleRender())
      : null;
    observer?.observe?.(chat, { childList: true });
    render();
    const unsubscribe = () => {
      chat.removeEventListener?.('click', click);
      observer?.disconnect?.();
      if (renderTimer !== null) clearTimeout(renderTimer);
      renderScheduled = false;
      for (const remove of subscriptions.splice(0)) remove();
    };
    this.#subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * Adds a small, ephemeral integrity badge to rendered messages that are
   * covered by a Mnemosyne candidate. It is intentionally read-only: the
   * callback may inspect local state, but this adapter never touches the ST
   * message object or chat metadata.
   */
  attachRenderedMessageHealth({ getHealth = () => null } = {}) {
    if (typeof document === 'undefined') return () => {};
    const context = this.#getContext();
    const source = context?.eventSource;
    const types = context?.eventTypes ?? context?.event_types;
    const chat = document.querySelector('#chat');
    if (!source || typeof source.on !== 'function' || !chat) return () => {};
    const normalizeHealth = value => {
      const status = String(value?.status ?? value ?? '').trim().toLowerCase();
      if (!['green', 'pending', 'stale', 'excluded', 'raw'].includes(status)) return null;
      const labels = { green: 'Memory green', pending: 'Memory pending — raw-only', stale: 'Memory stale — raw-only', excluded: 'Memory excluded — raw-only', raw: 'Memory raw-only' };
      const contextStatus = ['summarized', 'raw', 'unobserved'].includes(String(value?.contextStatus ?? '').trim().toLowerCase())
        ? String(value.contextStatus).trim().toLowerCase()
        : 'unobserved';
      const contextLabel = String(value?.contextLabel ?? (contextStatus === 'summarized'
        ? 'summarized — omitted from the last raw prompt'
        : contextStatus === 'raw' ? 'raw — retained in the last prompt' : 'context status not observed yet'));
      const contextSuffix = status === 'green'
        ? (contextStatus === 'summarized' ? ' · summarized' : contextStatus === 'raw' ? ' · raw retained' : ' · not observed')
        : '';
      return {
        status,
        contextStatus,
        contextLabel,
        label: String(value?.label ?? `${labels[status]}${contextSuffix}`),
        title: String(value?.title ?? `${labels[status]} · ${contextLabel}`),
      };
    };
    const toggleClass = (element, className, enabled) => {
      if (!element) return;
      if (element.classList?.toggle) {
        element.classList.toggle(className, enabled);
        return;
      }
      const classes = String(element.getAttribute?.('class') ?? element.className ?? '')
        .split(/\s+/).filter(Boolean).filter(value => value !== className);
      if (enabled) classes.push(className);
      element.setAttribute?.('class', classes.join(' '));
    };
    const setContextState = (message, health) => {
      const contextState = health?.contextStatus ?? 'unobserved';
      const text = message.querySelector?.('.mes_text');
      // Keep a class on the wrapper as well as .mes_text.  Some ST themes
      // scope descendant colors through .mes and otherwise outrank an
      // inherited color from the text node.
      toggleClass(message, 'mnemosyne-context-summarized', contextState === 'summarized');
      toggleClass(text, 'mnemosyne-message-summarized', contextState === 'summarized');
      if (text) {
        text.setAttribute?.('data-mnemosyne-context-state', contextState);
        text.setAttribute?.('data-mnemosyne-context-label', health?.contextLabel ?? '');
      }
      message.setAttribute?.('data-mnemosyne-context-state', contextState);
    };
    let lastRenderSignature = null;
    const render = () => {
      const messages = renderedMessages(chat);
      let greenCount = 0;
      let pendingCount = 0;
      let staleCount = 0;
      let excludedCount = 0;
      let summarizedCount = 0;
      let rawCount = 0;
      let unobservedCount = 0;
      let missingTextCount = 0;
      for (const message of messages) {
        const index = normalizeRenderedMessageIndex(message.getAttribute?.('mesid') ?? message.dataset?.mesid);
        if (index === null) continue;
        let health = null;
        try { health = normalizeHealth(getHealth(index)); } catch { health = null; }
        const existing = message.querySelector?.('[data-mnemosyne-message-health]');
        if (!health || health.status === 'raw') {
          existing?.remove?.();
          setContextState(message, null);
          rawCount += 1;
          continue;
        }
        if (health.status === 'green') greenCount += 1;
        if (health.status === 'pending') pendingCount += 1;
        if (health.status === 'stale') staleCount += 1;
        if (health.status === 'excluded') excludedCount += 1;
        if (health.contextStatus === 'summarized') summarizedCount += 1;
        if (health.contextStatus === 'raw') rawCount += 1;
        if (health.contextStatus === 'unobserved') unobservedCount += 1;
        if (!message.querySelector?.('.mes_text')) missingTextCount += 1;
        setContextState(message, health);
        const badge = existing ?? document.createElement('span');
        badge.className = `mnemosyne-message-health mnemosyne-message-health-${health.status} mnemosyne-message-context-${health.contextStatus}`;
        badge.dataset.mnemosyneMessageHealth = health.status;
        badge.dataset.mnemosyneMessageContext = health.contextStatus;
        badge.setAttribute?.('data-mnemosyne-message-health', health.status);
        badge.setAttribute?.('data-mnemosyne-message-context', health.contextStatus);
        badge.setAttribute('aria-label', health.label);
        badge.title = health.title;
        badge.textContent = health.label;
        if (!existing) {
          const host = message.querySelector?.('.extraMesButtons, .mes_buttons') ?? message;
          host.append?.(badge);
        }
      }
      const signature = [messages.length, greenCount, pendingCount, staleCount, excludedCount, summarizedCount, rawCount, unobservedCount, missingTextCount].join(':');
      if (signature !== lastRenderSignature) {
        lastRenderSignature = signature;
        this.#logger?.info?.('render_context_state', {
          renderedMessageCount: messages.length,
          greenCount,
          pendingCount,
          staleCount,
          excludedCount,
          summarizedCount,
          rawCount,
          unobservedCount,
          missingTextCount,
          observation: summarizedCount > 0 ? 'last_prompt_observed' : (unobservedCount > 0 ? 'prompt_not_observed' : 'raw_or_stale_only'),
        });
      }
    };
    const subscriptions = [];
    const eventKeys = [...RENDER_REPAIR_EVENT_KEYS, 'CHAT_COMPLETION_PROMPT_READY'];
    // See attachRenderedMessageRepair: a MutationObserver callback can fire
    // once per inserted message while ST hydrates a chat.  Coalesce those
    // callbacks, while retaining microtask timing for ST event notifications.
    let renderScheduled = false;
    let renderTimer = null;
    const scheduleRender = ({ defer = true } = {}) => {
      if (defer && renderTimer !== null) clearTimeout(renderTimer);
      if (renderScheduled && (!defer || renderTimer === null)) return;
      renderScheduled = true;
      const run = () => {
        renderScheduled = false;
        renderTimer = null;
        render();
      };
      if (defer) renderTimer = setTimeout(run, 16);
      else queueMicrotask(run);
    };
    for (const key of eventKeys) {
      const eventName = types?.[key];
      if (!eventName) continue;
      const listener = () => { scheduleRender({ defer: false }); };
      source.on(eventName, listener);
      subscriptions.push(() => source.removeListener?.(eventName, listener));
    }
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => scheduleRender()) : null;
    observer?.observe?.(chat, { childList: true });
    render();
    const unsubscribe = () => {
      observer?.disconnect?.();
      if (renderTimer !== null) clearTimeout(renderTimer);
      renderScheduled = false;
      for (const remove of subscriptions.splice(0)) remove();
      for (const message of renderedMessages(chat)) {
        message.querySelector?.('[data-mnemosyne-message-health]')?.remove?.();
        const text = message.querySelector?.('.mes_text');
        toggleClass(message, 'mnemosyne-context-summarized', false);
        toggleClass(text, 'mnemosyne-message-summarized', false);
        text?.removeAttribute?.('data-mnemosyne-context-state');
        text?.removeAttribute?.('data-mnemosyne-context-label');
        message.removeAttribute?.('data-mnemosyne-context-state');
      }
    };
    this.#subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  normalize(kind, payload) {
    const context = this.#getContext();
    const index = ['edited', 'deleted', 'swiped'].includes(kind) && Number.isInteger(Number(payload))
      ? Number(payload)
      : null;
    return Object.freeze({
      kind,
      chatId: String(context.chatId ?? context.getCurrentChatId?.() ?? ''),
      messageIndex: index,
      generationType: payload && typeof payload === 'object' ? payload.type ?? null : null,
    });
  }

  dispose() {
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
  }
}

export { EVENT_KEYS };

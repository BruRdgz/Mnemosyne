export function createEventBus() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload);
    },
    count(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

export function createFakeContext(overrides = {}) {
  const eventSource = createEventBus();
  const prompts = new Map();
  const promptCalls = [];
  let metadataSaves = 0;
  const context = {
    chatId: 'fixture-chat',
    chat: [
      { is_user: true, is_system: false, name: 'User', mes: 'Hello', swipe_id: 0 },
      { is_user: false, is_system: false, name: 'Character', mes: 'Hi', swipe_id: 0 },
    ],
    chatMetadata: {},
    eventSource,
    eventTypes: {
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_DELETED: 'message_deleted',
      MESSAGE_SWIPED: 'message_swiped',
      MESSAGE_SENT: 'message_sent',
      MESSAGE_RECEIVED: 'message_received',
      CHAT_CHANGED: 'chat_changed',
      CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    },
    getTokenCountAsync: async text => Math.ceil(String(text).length / 4),
    setExtensionPrompt: (key, value, position, depth, scan, role) => {
      prompts.set(key, value);
      promptCalls.push({ key, value, position, depth, scan, role });
    },
    symbols: { ignore: Symbol.for('ignore') },
    saveMetadata: async () => { metadataSaves += 1; },
    generateRaw: async () => 'ok',
    ...overrides,
  };
  return { context, eventSource, prompts, promptCalls, metadataSaves: () => metadataSaves };
}

export function createMemoryLocalForage() {
  const instances = [];
  const stores = new Map();
  return {
    instances,
    createInstance(options) {
      const namespace = `${options?.name ?? ''}:${options?.storeName ?? ''}`;
      if (!stores.has(namespace)) stores.set(namespace, new Map());
      const values = stores.get(namespace);
      const instance = {
        options,
        setItem: async (key, value) => (values.set(key, structuredClone(value)), value),
        getItem: async key => structuredClone(values.get(key) ?? null),
        removeItem: async key => values.delete(key),
        keys: async () => [...values.keys()],
      };
      instances.push(instance);
      return instance;
    },
  };
}

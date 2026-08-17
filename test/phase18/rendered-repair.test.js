import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRenderedMessageIndex, StEventAdapter } from '../../src/integration/st-event-adapter.js';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createSourceRange } from '../../src/domain/fingerprint.js';
import { emptyEpisodeSummary } from '../../src/domain/schema.js';
import { createPortableEnvelope } from '../../src/storage/semantic-store.js';
import { segmentIdFromSource } from '../../src/domain/ids.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';
import { createEventBus } from '../helpers/fakes.js';

test('Phase 18: rendered message indices are normalized conservatively', () => {
  assert.equal(normalizeRenderedMessageIndex('3'), 3);
  assert.equal(normalizeRenderedMessageIndex(0), 0);
  assert.equal(normalizeRenderedMessageIndex(-1), null);
  assert.equal(normalizeRenderedMessageIndex('3.5'), null);
  assert.equal(normalizeRenderedMessageIndex('message'), null);
});

test('Phase 18: rendered-message repair target is local, source-bound, and blue/green', async () => {
  const fake = createFakeContext({
    chat: [
      { is_user: true, is_system: false, name: 'User', mes: 'A', swipe_id: 0 },
      { is_user: false, is_system: false, name: 'Character', mes: 'B', swipe_id: 0 },
    ],
  });
  const source = createSourceRange([
    { index: 0, role: 'user', name: 'User', text: 'A', swipeId: 0 },
    { index: 1, role: 'assistant', name: 'Character', text: 'B', swipeId: 0 },
  ], 0);
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: 0, lastIndex: 1,
    dependencyIds: [], sourceTokenCount: 2, summary: emptyEpisodeSummary('Green scene'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  fake.context.chatMetadata = { mnemosyne: envelope };
  let providerCalls = 0;
  fake.context.generateRaw = async () => { providerCalls += 1; return '{}'; };
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { autoCompact: false } },
    localforage: createMemoryLocalForage(),
  });
  const target = runtime.narrative.messageRepairTarget(1);
  assert.equal(target.segmentId, envelope.segments[0].id);
  assert.equal(runtime.narrative.messageHealth(0).status, 'green');
  assert.equal(runtime.messageHealth(1).status, 'green');
  assert.equal(runtime.narrative.messageRepairTarget(9), null);
  const analysis = await runtime.narrative.analyzeMessageRepair(0);
  assert.equal(analysis.segmentId, envelope.segments[0].id);
  assert.equal(analysis.estimatedRequests, 1);
  assert.equal(providerCalls, 0);
  assert.equal(runtime.narrative.snapshot().segments[0].summary.synopsis, 'Green scene');
  runtime.dispose();
});

test('Phase 18: runtime marks only omitted green source messages as greyed-out context', async () => {
  const chat = [
    { is_user: true, is_system: false, name: 'User', mes: 'Old user scene', swipe_id: 0 },
    { is_user: false, is_system: false, name: 'Character', mes: 'Old assistant scene', swipe_id: 0 },
    { is_user: true, is_system: false, name: 'User', mes: 'Current user scene', swipe_id: 0 },
    { is_user: false, is_system: false, name: 'Character', mes: 'Current assistant scene', swipe_id: 0 },
  ];
  const source = createSourceRange([
    { index: 0, role: 'user', name: 'User', text: 'Old user scene', swipeId: 0 },
    { index: 1, role: 'assistant', name: 'Character', text: 'Old assistant scene', swipeId: 0 },
  ], 0);
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: 0, lastIndex: 1,
    dependencyIds: [], sourceTokenCount: 8, summary: emptyEpisodeSummary('Old scene'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  const fake = createFakeContext({ chat, chatMetadata: { mnemosyne: envelope } });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { autoCompact: false, rawTailBudget: 2, contextBudget: 100, contextReserveTokens: 0 } },
    localforage: createMemoryLocalForage(),
  });
  const generationChat = structuredClone(fake.context.chat);
  const compiled = await runtime.narrative.intercept(generationChat, 100, 'normal');
  assert.deepEqual(compiled.omitIndices, [0, 1]);
  assert.equal(runtime.messageHealth(0).contextStatus, 'summarized');
  assert.match(runtime.messageHealth(0).contextLabel, /omitted/);
  assert.equal(runtime.messageHealth(1).contextStatus, 'summarized');
  runtime.dispose();
});

test('Phase 18: periodic integrity audit marks old edits stale before compaction and never calls the provider', async () => {
  const chat = [
    { is_user: true, is_system: false, name: 'User', mes: 'Original user', swipe_id: 0 },
    { is_user: false, is_system: false, name: 'Character', mes: 'Original answer', swipe_id: 0 },
  ];
  const source = createSourceRange([
    { index: 0, role: 'user', name: 'User', text: 'Original user', swipeId: 0 },
    { index: 1, role: 'assistant', name: 'Character', text: 'Original answer', swipeId: 0 },
  ], 0);
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: 0, lastIndex: 1,
    dependencyIds: [], sourceTokenCount: 2, summary: emptyEpisodeSummary('Original scene'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  let providerCalls = 0;
  const fake = createFakeContext({ chat, chatMetadata: { mnemosyne: envelope }, generateRaw: async () => { providerCalls += 1; return '{}'; } });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { autoCompact: false, integrityAuditIntervalMessages: 2 } },
    localforage: createMemoryLocalForage(),
  });
  fake.context.chat[0].mes = 'Edited user';
  await runtime.narrative.handleEvent({ kind: 'received' });
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'valid');
  await runtime.narrative.handleEvent({ kind: 'received' });
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'stale');
  assert.equal(providerCalls, 0);
  assert.ok(runtime.metrics.snapshot().some(item => item.operation === 'integrity_audit' && item.status === 'stale'));
  runtime.dispose();
});

test('Phase 18: failed periodic integrity persistence blocks compaction before provider work', async () => {
  const chat = [
    { is_user: true, is_system: false, name: 'User', mes: 'Original user', swipe_id: 0 },
    { is_user: false, is_system: false, name: 'Character', mes: 'Original answer', swipe_id: 0 },
  ];
  const source = createSourceRange([
    { index: 0, role: 'user', name: 'User', text: 'Original user', swipeId: 0 },
    { index: 1, role: 'assistant', name: 'Character', text: 'Original answer', swipeId: 0 },
  ], 0);
  const envelope = createPortableEnvelope('fixture-chat');
  envelope.segments = [{
    id: segmentIdFromSource(source.rangeFingerprint), source, firstIndex: 0, lastIndex: 1,
    dependencyIds: [], sourceTokenCount: 2, summary: emptyEpisodeSummary('Original scene'), status: 'valid',
    createdAt: 1, updatedAt: 1, schemaVersion: 1, promptVersion: 2, manuallyEdited: false, pinned: false,
    extraction: { replacementEligible: true },
  }];
  let failWrites = false;
  let providerCalls = 0;
  const fake = createFakeContext({
    chat,
    chatMetadata: { mnemosyne: envelope },
    saveMetadata: async () => { if (failWrites) throw new Error('periodic audit write failed'); },
    generateRaw: async () => { providerCalls += 1; return '{}'; },
  });
  const runtime = await bootstrapMnemosyne({
    getContext: () => fake.context,
    extensionSettings: { mnemosyne: { autoCompact: true, rawTailBudget: 1, contextBudget: 100, preemptiveRatio: 0.8, integrityAuditIntervalMessages: 1, memoryCooldownMs: 0 } },
    localforage: createMemoryLocalForage(),
  });
  failWrites = true;
  fake.context.chat[0].mes = 'Edited user';
  await runtime.narrative.handleEvent({ kind: 'received' });
  await runtime.narrative.flushBackground();
  assert.equal(providerCalls, 0, 'a failed local audit must block compaction before the provider');
  assert.equal(runtime.narrative.generationStatus().memoryOperationBusy, false);
  assert.equal(runtime.narrative.snapshot().segments[0].status, 'valid', 'failed audit must preserve the green baseline');
  assert.ok(runtime.metrics.snapshot().some(item => item.operation === 'integrity_periodic_audit' && item.status === 'failed'));
  runtime.dispose();
});

test('Phase 18: rendered-message repair registration is inert without a public chat DOM', () => {
  const adapter = new StEventAdapter({ getContext: () => ({}) });
  const dispose = adapter.attachRenderedMessageRepair({ canRepair: () => true });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('Phase 18: rendered-message repair controls are ephemeral, eligible-only, and click through with the source index', async () => {
  class Node {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.parentNode = null; this.attributes = new Map(); this.dataset = {}; this.listeners = new Map(); this.textContent = ''; }
    set className(value) { this.setAttribute('class', value); }
    get className() { return this.getAttribute('class') ?? ''; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith('data-')) this.dataset[name.slice(5).replaceAll('-', '_')] = String(value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(child) { child.parentNode = this; this.children.push(child); }
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
    dispatch(name, event) { this.listeners.get(name)?.({ target: this, preventDefault() { event.prevented = true; }, stopPropagation() { event.stopped = true; }, ...event }); }
    matches(selector) {
      if (selector === '.mes[mesid]') return this.className.split(/\s+/).includes('mes') && this.getAttribute('mesid') !== null;
      if (selector === '[data-mnemosyne-message-repair]') return this.attributes.has('data-mnemosyne-message-repair') || this.dataset.mnemosyneMessageRepair !== undefined;
      if (selector === '[data-mnemosyne-message-health]') return this.attributes.has('data-mnemosyne-message-health') || this.dataset.mnemosyneMessageHealth !== undefined;
      if (selector === '.mes_text') return this.className.split(/\s+/).includes('mes_text');
      if (selector === '.extraMesButtons, .mes_buttons') return this.className.split(/\s+/).some(value => ['extraMesButtons', 'mes_buttons'].includes(value));
      return false;
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  }
  const originalDocument = globalThis.document;
  const originalObserver = globalThis.MutationObserver;
  const chat = new Node('div');
  const message = new Node('article'); message.className = 'mes'; message.setAttribute('mesid', '4');
  const text = new Node('div'); text.className = 'mes_text'; message.append(text);
  const buttons = new Node('div'); buttons.className = 'mes_buttons'; message.append(buttons); chat.append(message);
  const bus = createEventBus();
  let eligible = true;
  const calls = [];
  globalThis.document = { querySelector: selector => selector === '#chat' ? chat : null, createElement: tag => new Node(tag) };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const adapter = new StEventAdapter({ getContext: () => ({ chat: [], eventSource: bus, eventTypes: { MESSAGE_UPDATED: 'message_updated' } }) });
  const dispose = adapter.attachRenderedMessageRepair({ canRepair: index => eligible && index === 4, onRepair: async index => { calls.push(index); } });
  const healthDispose = adapter.attachRenderedMessageHealth({ getHealth: index => index === 4 ? { status: eligible ? 'green' : 'pending', contextStatus: eligible ? 'summarized' : 'raw' } : null });
  const button = message.querySelector('[data-mnemosyne-message-repair]');
  assert.ok(button);
  assert.equal(message.querySelector('[data-mnemosyne-message-health]')?.dataset.mnemosyneMessageHealth, 'green');
  assert.match(text.className, /mnemosyne-message-summarized/);
  assert.match(message.className, /mnemosyne-context-summarized/);
  assert.equal(text.getAttribute('data-mnemosyne-context-state'), 'summarized');
  const event = {};
  chat.dispatch('click', { target: button, ...event });
  await Promise.resolve();
  assert.deepEqual(calls, [4]);
  eligible = false;
  bus.emit('message_updated');
  await Promise.resolve();
  assert.equal(message.querySelector('[data-mnemosyne-message-repair]'), null);
  assert.equal(message.querySelector('[data-mnemosyne-message-health]')?.dataset.mnemosyneMessageHealth, 'pending');
  assert.doesNotMatch(text.className, /mnemosyne-message-summarized/);
  assert.doesNotMatch(message.className, /mnemosyne-context-summarized/);
  assert.equal(text.getAttribute('data-mnemosyne-context-state'), 'raw');
  healthDispose();
  dispose();
  globalThis.document = originalDocument;
  globalThis.MutationObserver = originalObserver;
});

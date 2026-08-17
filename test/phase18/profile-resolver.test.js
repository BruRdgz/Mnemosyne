import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfilePatch, normalizeProfileCatalog, removeProfileDefinition, resolveEffectiveProfile, upsertProfileDefinition } from '../../src/config/profile-resolver.js';
import { bootstrapMnemosyne } from '../../src/integration/bootstrap.js';
import { createFakeContext, createMemoryLocalForage } from '../helpers/fakes.js';

test('Phase 18: effective profiles layer default, character, group, chat, and chat overrides deterministically', () => {
  const resolved = resolveEffectiveProfile({
    baseSettings: { contextBudget: 12_000, memoryCooldownMs: 3_000, retrievalMode: 'lexical' },
    profiles: {
      default: { contextBudget: 10_000, memoryCooldownMs: 2_000 },
      characters: { ava: { contextBudget: 9_000 } },
      groups: { writers: { memoryCooldownMs: 1_000 } },
      chats: { 'chat-1': { retrievalMode: 'hybrid' } },
    },
    identity: { chatId: 'chat-1', characterId: 'ava', groupId: 'writers' },
    chatPreferences: { profileOverrides: { memoryCooldownMs: 500 } },
  });
  assert.deepEqual(resolved.values, { contextBudget: 9_000, memoryCooldownMs: 500, retrievalMode: 'hybrid' });
  assert.equal(resolved.sources.contextBudget, 'profile:character:ava');
  assert.equal(resolved.sources.memoryCooldownMs, 'chat override');
  assert.deepEqual(resolved.appliedScopes, ['profile:default', 'profile:character:ava', 'profile:group:writers', 'profile:chat:chat-1', 'chat override']);
});

test('Phase 18: profile patches reject invalid values and never carry narrative fields', () => {
  assert.deepEqual(normalizeProfilePatch({ contextBudget: -1, memoryTemperature: 3, memoryTopP: 2, preemptiveRatio: 2, retrievalMode: 'invalid', synopsis: 'secret', autoCompact: true, injectManagedMemory: false, memoryConnectionProfileId: '' }), { autoCompact: true, injectManagedMemory: false, memoryConnectionProfileId: null });
});

test('Phase 18: scoped profile catalog CRUD is normalized and narrative-free', () => {
  const initial = normalizeProfileCatalog({ characters: { ava: { contextBudget: 9_000, synopsis: 'discarded' } }, groups: { writers: { memoryCooldownMs: 1_000 } }, ignored: { text: 'discarded' } });
  assert.deepEqual(initial.characters.ava, { contextBudget: 9_000 });
  const updated = upsertProfileDefinition(initial, { scope: 'characters', id: 'ava', patch: { rawTailBudget: 2_000, synopsis: 'discarded' } });
  assert.deepEqual(updated.characters.ava, { contextBudget: 9_000, rawTailBudget: 2_000 });
  const removed = removeProfileDefinition(updated, { scope: 'groups', id: 'writers' });
  assert.equal(removed.groups.writers, undefined);
  assert.throws(() => upsertProfileDefinition(initial, { scope: 'groups', id: '', patch: { contextBudget: 1000 } }), /requires an id/);
});

test('Phase 18: runtime scoped profile writes settings, refreshes resolution, and never touches semantic memory', async () => {
  let settingSaves = 0;
  const fake = createFakeContext({ characterId: 'ava', groupId: 'writers', saveSettingsDebounced: () => { settingSaves += 1; } });
  const extensionSettings = { mnemosyne: { autoCompact: false } };
  const runtime = await bootstrapMnemosyne({ getContext: () => fake.context, extensionSettings, localforage: createMemoryLocalForage() });
  await runtime.setScopedProfile('characters', 'ava', { contextBudget: 9_000, synopsis: 'must never persist' });
  assert.equal(extensionSettings.mnemosyne.memoryProfiles.characters.ava.contextBudget, 9_000);
  assert.equal(extensionSettings.mnemosyne.memoryProfiles.characters.ava.synopsis, undefined);
  assert.equal(runtime.narrative.profileStatus().values.contextBudget, 9_000);
  assert.equal(runtime.snapshot().segments.length, 0);
  assert.ok(settingSaves >= 1);
  await runtime.deleteScopedProfile('characters', 'ava');
  assert.equal(extensionSettings.mnemosyne.memoryProfiles.characters.ava, undefined);
  runtime.dispose();
});

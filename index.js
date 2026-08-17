import { extension_settings, getContext, saveMetadataDebounced } from '/scripts/extensions.js';
import { localforage } from '/lib.js';
import { bootstrapMnemosyne } from './src/integration/bootstrap.js';
import { registerMnemosyneSlashCommands } from './src/integration/slash-commands.js';

const MODULE_NAME = 'mnemosyne';
let runtime;
let slashCommandsDispose;

async function getRuntime() {
  if (!runtime) {
    runtime = await bootstrapMnemosyne({
      getContext,
      extensionSettings: extension_settings,
      saveMetadataDebounced,
      localforage,
    });
    try {
      const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
      slashCommandsDispose = registerMnemosyneSlashCommands({ parser: SlashCommandParser, runtime });
    } catch (error) {
      // Older ST builds may not expose the public parser module. Mnemosyne's
      // dashboard and generation path remain fully functional without it.
      console.warn('[Mnemosyne] slash command surface unavailable', error);
    }
  }
  return runtime;
}

globalThis.mnemosyne_intercept_messages = async (...args) => {
  const current = await getRuntime();
  return current.intercept(...args);
};

export async function enableMnemosyne() {
  const current = await getRuntime();
  current.setEnabled(true);
}

export async function disableMnemosyne() {
  if (runtime) {
    slashCommandsDispose?.();
    slashCommandsDispose = undefined;
    runtime.setEnabled(false);
    runtime.dispose();
    runtime = undefined;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void getRuntime(), { once: true });
} else {
  void getRuntime();
}

export { MODULE_NAME };

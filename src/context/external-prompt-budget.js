import { PROMPT_KEY, ST_EXTENSION_PROMPT } from '../core/constants.js';

const ACTIVE_POSITIONS = new Set([
  ST_EXTENSION_PROMPT.position.IN_PROMPT,
  ST_EXTENSION_PROMPT.position.IN_CHAT,
  ST_EXTENSION_PROMPT.position.BEFORE_PROMPT,
]);

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeEntries(source) {
  if (source === null || source === undefined) return { available: false, entries: [] };
  if (source instanceof Map) return { available: true, entries: [...source.entries()] };
  if (Array.isArray(source)) return { available: true, entries: source.map((entry, index) => [entry?.key ?? entry?.id ?? index, entry]) };
  if (typeof source === 'object') return { available: true, entries: Object.entries(source) };
  return { available: false, entries: [] };
}

function normalizePrompt(key, value) {
  if (typeof value === 'string') return { key: String(key), text: value, position: null, depth: null, scan: null, role: null };
  const text = value?.value ?? value?.text ?? value?.content ?? '';
  return {
    key: String(key),
    text: typeof text === 'string' ? text : String(text ?? ''),
    position: Number.isFinite(Number(value?.position)) ? Number(value.position) : null,
    depth: Number.isFinite(Number(value?.depth)) ? Number(value.depth) : null,
    scan: typeof value?.scan === 'boolean' ? value.scan : null,
    role: Number.isFinite(Number(value?.role)) ? Number(value.role) : null,
  };
}

/**
 * Normalize an optional public prompt-manager breakdown. SillyTavern does not
 * expose this on every build, so the caller must treat `available: false` as
 * the normal path. The shape is deliberately small and provider-agnostic:
 * entries are already counted by ST's active tokenizer and must exclude the
 * Mnemosyne extension prompt.
 */
function normalizePublicBreakdown(value) {
  if (!value || typeof value !== 'object') return { available: false, entries: [], totalTokens: 0, exact: false, source: null };
  const rawEntries = Array.isArray(value.entries)
    ? value.entries
    : value.regions && typeof value.regions === 'object'
      ? Object.entries(value.regions).map(([key, tokens]) => ({ key, tokens }))
      : [];
  const entries = rawEntries.map((entry, index) => {
    const key = String(entry?.key ?? entry?.id ?? entry?.region ?? `region:${index}`);
    const tokens = finiteNonNegative(entry?.tokens ?? entry?.tokenCount ?? entry?.count, 0);
    return {
      key,
      tokens,
      label: typeof entry?.label === 'string' ? entry.label : null,
      category: typeof entry?.category === 'string' ? entry.category : null,
    };
  });
  const entryTotal = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const declaredTotal = Number(value.totalTokens ?? value.tokens ?? value.total);
  const totalTokens = Number.isFinite(declaredTotal) && declaredTotal >= 0 ? declaredTotal : entryTotal;
  const source = typeof value.source === 'string' && value.source.trim() ? value.source.trim() : 'public_prompt_breakdown';
  // `exact` is accepted only when the producer explicitly says this is a
  // pre-generation, complete breakdown. Merely exposing a token total is not
  // enough to claim that card/lorebook/example items were all included.
  const exact = value.exact === true && (value.phase === 'pre_generation' || value.complete === true);
  return { available: true, entries, totalTokens, exact, source };
}

async function countWithFallback(text, countTokens) {
  try {
    const counted = Number(await countTokens(text));
    if (Number.isFinite(counted) && counted >= 0) return { tokens: counted, source: 'st_tokenizer' };
  } catch { /* deterministic local fallback below */ }
  return { tokens: Math.ceil(String(text).length / 4), source: 'estimated_chars_4' };
}

/**
 * Measures the public extension-prompt registry without touching ST's private
 * PromptManager or invoking a model. The registry is intentionally treated as
 * a partial measurement: configured reserve remains in force for cards,
 * lorebooks, examples, framing, and prompt-manager items not exposed here.
 */
export async function measureExternalPromptBudget({
  extensionPrompts = null,
  countTokens,
  excludedKeys = [PROMPT_KEY],
  configuredReserve = 0,
  maximumPromptTokens = 0,
  publicBreakdown = null,
} = {}) {
  if (typeof countTokens !== 'function') throw new TypeError('measureExternalPromptBudget requires countTokens');
  const normalized = normalizeEntries(extensionPrompts);
  const excluded = new Set(excludedKeys.map(key => String(key)));
  const entries = [];
  let fallbackCount = 0;
  let skipped = 0;
  let measuredTokens = 0;

  for (const [key, value] of normalized.entries) {
    const prompt = normalizePrompt(key, value);
    if (excluded.has(prompt.key) || !prompt.text) {
      skipped += 1;
      continue;
    }
    // NONE/hidden prompts are not part of the outgoing prompt. Unknown
    // positions are retained because older ST builds did not always expose
    // the numeric field; the reserve remains conservative in that case.
    if (prompt.position !== null && !ACTIVE_POSITIONS.has(prompt.position)) {
      skipped += 1;
      continue;
    }
    const counted = await countWithFallback(prompt.text, countTokens);
    if (counted.source !== 'st_tokenizer') fallbackCount += 1;
    measuredTokens += counted.tokens;
    entries.push({
      key: prompt.key,
      tokens: counted.tokens,
      source: counted.source,
      characters: prompt.text.length,
      position: prompt.position,
      depth: prompt.depth,
      scan: prompt.scan,
      role: prompt.role,
    });
  }

  const breakdown = normalizePublicBreakdown(publicBreakdown);
  if (breakdown.available) {
    const excludedBreakdownEntries = breakdown.entries.filter(entry => excluded.has(entry.key));
    if (excludedBreakdownEntries.length) {
      // A producer that accidentally includes Mnemosyne's own block cannot
      // claim an exact external total. Remove the known self-entry and fall
      // back to conservative partial accounting instead of double-counting.
      const selfTokens = excludedBreakdownEntries.reduce((sum, entry) => sum + entry.tokens, 0);
      breakdown.entries = breakdown.entries.filter(entry => !excluded.has(entry.key));
      breakdown.totalTokens = Math.max(0, breakdown.totalTokens - selfTokens);
      breakdown.exact = false;
    }
    // A complete public breakdown supersedes registry counting to avoid
    // double-counting the same card/lorebook entries. For a partial public
    // breakdown, retain the larger value as a conservative lower bound.
    measuredTokens = breakdown.exact ? breakdown.totalTokens : Math.max(measuredTokens, breakdown.totalTokens);
    if (breakdown.entries.length) {
      const normalizedBreakdownEntries = breakdown.entries.map(entry => ({
        key: entry.key,
        tokens: entry.tokens,
        source: 'st_public_breakdown',
        characters: null,
        position: null,
        depth: null,
        scan: null,
        role: null,
        category: entry.category,
        label: entry.label,
      }));
      if (breakdown.exact) entries.splice(0, entries.length, ...normalizedBreakdownEntries);
      else entries.push(...normalizedBreakdownEntries);
    }
  }

  const configured = finiteNonNegative(configuredReserve);
  const requestedReserve = Math.max(configured, measuredTokens);
  const maximum = finiteNonNegative(maximumPromptTokens);
  const reserveCap = maximum >= 1_024 ? Math.floor(maximum * 0.5) : 0;
  const effectiveReserve = maximum >= 1_024 ? Math.min(requestedReserve, reserveCap) : 0;
  const budgetSource = breakdown.available
    ? (breakdown.exact ? 'st_public_prompt_breakdown' : 'st_public_prompt_breakdown_partial')
    : measuredTokens > 0 && configured > 0
      ? 'public_extension_prompts+configured_reserve'
      : measuredTokens > 0
        ? 'public_extension_prompts'
        : configured > 0
          ? 'configured_reserve'
          : 'none';
  const coverage = breakdown.available
    ? (breakdown.exact ? 'st_public_prompt_breakdown_exact' : 'st_public_prompt_breakdown_partial')
    : normalized.available && configured > 0
      ? 'public_extension_prompts_plus_configured_reserve'
      : normalized.available
        ? 'public_extension_prompts_only'
        : configured > 0
          ? 'configured_reserve_only'
          : 'unavailable';

  return {
    registryAvailable: normalized.available,
    measuredTokens,
    measuredEntryCount: entries.length,
    skippedEntryCount: skipped,
    fallbackEntryCount: fallbackCount,
    entries,
    configuredReserve: configured,
    requestedReserve,
    reserveCap,
    effectiveReserve,
    availableManagedTokens: maximum ? Math.max(0, maximum - effectiveReserve) : null,
    budgetSource,
    coverage,
    publicBreakdown: breakdown.available ? breakdown : null,
    exactFinalPromptItemization: breakdown.available && breakdown.exact,
  };
}

function observedContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : (item?.text ?? '')).join('\n');
  return value?.text ?? '';
}

/**
 * Best-effort post-generation observation of public extension values. ST's
 * final prompt event intentionally exposes only chat messages, so this is
 * reported as partial substring matching rather than exact PromptManager
 * itemization. No prompt prose is returned.
 */
export async function observeExternalPromptBudget({ extensionPrompts = null, chat = [], countTokens, excludedKeys = [PROMPT_KEY] } = {}) {
  if (typeof countTokens !== 'function') throw new TypeError('observeExternalPromptBudget requires countTokens');
  const normalized = normalizeEntries(extensionPrompts);
  if (!normalized.available || !Array.isArray(chat)) return { available: false, matchedEntryCount: 0, matchedTokens: 0, entries: [], exactFinalPromptItemization: false };
  const excluded = new Set(excludedKeys.map(key => String(key)));
  const messages = chat.map((message, index) => ({ index, text: observedContent(message?.content) }));
  const entries = [];
  let matchedTokens = 0;
  for (const [key, value] of normalized.entries) {
    const prompt = normalizePrompt(key, value);
    if (excluded.has(prompt.key) || !prompt.text) continue;
    if (prompt.position !== null && !ACTIVE_POSITIONS.has(prompt.position)) continue;
    const match = messages.find(message => message.text.includes(prompt.text));
    if (!match) continue;
    const counted = await countWithFallback(prompt.text, countTokens);
    matchedTokens += counted.tokens;
    entries.push({ key: prompt.key, tokens: counted.tokens, source: counted.source, messageIndex: match.index, match: 'exact_substring' });
  }
  return { available: true, matchedEntryCount: entries.length, matchedTokens, entries, exactFinalPromptItemization: false };
}

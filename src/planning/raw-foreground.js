export const DEFAULT_MESSAGE_POLICY = Object.freeze({
  includeUser: true,
  includeAssistant: true,
  includeSystem: false,
  includeHidden: false,
});

function roleOf(message) {
  return message.role ?? (message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'));
}

export function shouldIncludeMessage(message, policy = DEFAULT_MESSAGE_POLICY) {
  const role = roleOf(message);
  const hidden = Boolean(message.hidden || message.isHidden);
  if (hidden && !policy.includeHidden) return false;
  if (role === 'system') return Boolean(policy.includeSystem);
  if (role === 'user') return Boolean(policy.includeUser);
  return Boolean(policy.includeAssistant);
}

export function planRawForeground(messages, {
  budgetTokens,
  policy = DEFAULT_MESSAGE_POLICY,
  metrics = null,
} = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new TypeError('budgetTokens must be a positive integer');

  const eligible = messages
    .map((message, index) => ({ ...message, index: message.index ?? index, role: roleOf(message) }))
    .filter(message => shouldIncludeMessage(message, policy));

  if (eligible.length === 0) {
    return Object.freeze({ messages: [], indices: [], totalTokens: 0, budgetTokens, overflowTokens: 0, withinBudget: true, reason: 'empty' });
  }

  const latestUserPosition = eligible.findLastIndex(message => message.role === 'user');
  const forcedStart = latestUserPosition >= 0 ? latestUserPosition : eligible.length - 1;
  const selected = eligible.slice(forcedStart);
  let totalTokens = selected.reduce((sum, message) => sum + checkedTokenCount(message), 0);

  for (let position = forcedStart - 1; position >= 0; position -= 1) {
    const candidate = eligible[position];
    const candidateTokens = checkedTokenCount(candidate);
    if (totalTokens + candidateTokens > budgetTokens) break;
    selected.unshift(candidate);
    totalTokens += candidateTokens;
  }

  const overflowTokens = Math.max(0, totalTokens - budgetTokens);
  const result = Object.freeze({
    messages: selected.map(message => message.original ?? messages[message.index] ?? message),
    indices: selected.map(message => message.index),
    firstIndex: selected[0]?.index ?? null,
    lastIndex: selected.at(-1)?.index ?? null,
    totalTokens,
    budgetTokens,
    overflowTokens,
    withinBudget: overflowTokens === 0,
    reason: overflowTokens > 0 ? 'required_current_turn_exceeds_budget' : 'within_budget',
    policy: Object.freeze({ ...DEFAULT_MESSAGE_POLICY, ...policy }),
  });
  metrics?.record({
    operation: 'raw_foreground_plan',
    candidateCount: eligible.length,
    selectedCount: selected.length,
    firstIndex: result.firstIndex,
    lastIndex: result.lastIndex,
    tokenCount: totalTokens,
    budgetTokens,
    overflowTokens,
    status: result.reason,
  });
  return result;
}

function checkedTokenCount(message) {
  if (!Number.isInteger(message.tokenCount) || message.tokenCount < 0) {
    throw new TypeError(`Message ${message.index} lacks a non-negative integer tokenCount`);
  }
  return message.tokenCount;
}

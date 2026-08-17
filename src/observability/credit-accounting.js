const finite = value => Number.isFinite(value) ? Math.max(0, Number(value)) : null;

export function pricingSnapshot(settings = {}, model = null) {
  return Object.freeze({
    model: model ? String(model) : null,
    inputMultiplier: finite(settings.memoryPricingInputMultiplier) ?? 0.5,
    outputMultiplier: finite(settings.memoryPricingOutputMultiplier) ?? 0.7,
    cacheMultiplier: finite(settings.memoryPricingCacheMultiplier) ?? 0.1,
    capturedAt: new Date().toISOString(),
  });
}

export function calculateCredits(usage, pricing) {
  const nominal = finite(usage?.nominalInputTokens);
  const cached = finite(usage?.cachedInputTokens);
  const explicitUncached = finite(usage?.uncachedInputTokens);
  const output = finite(usage?.outputTokens);
  const uncached = explicitUncached ?? (nominal !== null ? Math.max(0, nominal - (cached ?? 0)) : null);
  if (uncached === null && cached === null && output === null) return null;
  return (uncached ?? 0) * pricing.inputMultiplier
    + (cached ?? 0) * pricing.cacheMultiplier
    + (output ?? 0) * pricing.outputMultiplier;
}

export function aggregateAttemptCosts(attempts = []) {
  const totals = { nominalInputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, credits: 0, replayedCredits: 0, measuredAttempts: 0, estimatedAttempts: 0, replayAttempts: 0 };
  for (const attempt of attempts) {
    const usage = attempt.usage ?? {};
    for (const key of ['nominalInputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens']) {
      if (Number.isFinite(usage[key])) totals[key] += Number(usage[key]);
    }
    if (attempt.executionMode === 'replay' || attempt.usageSource === 'replay') {
      totals.replayAttempts += 1;
      if (Number.isFinite(attempt.replayedCredits)) totals.replayedCredits += Number(attempt.replayedCredits);
    } else if (Number.isFinite(attempt.credits)) totals.credits += Number(attempt.credits);
    if (attempt.usageSource === 'provider') totals.measuredAttempts += 1;
    else if (attempt.usageSource === 'estimated') totals.estimatedAttempts += 1;
  }
  return Object.freeze(totals);
}

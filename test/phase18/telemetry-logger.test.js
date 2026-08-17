import assert from 'node:assert/strict';
import test from 'node:test';
import { TelemetryLogger } from '../../src/observability/telemetry-logger.js';

test('Phase 18: local telemetry is bounded, redacted, and level-gated', () => {
  const calls = [];
  const logger = new TelemetryLogger({
    level: 'info',
    maxEntries: 2,
    now: () => '2026-08-14T00:00:00.000Z',
    sink: {
      info: (...args) => calls.push(['info', ...args]),
      warn: (...args) => calls.push(['warn', ...args]),
      log: (...args) => calls.push(['log', ...args]),
    },
  });
  logger.debug('hidden_debug', { value: 1 });
  logger.info('render_context_state', { messageIndex: 3, synopsis: 'private prose', summarizedCount: 2 });
  logger.metric({ operation: 'memory_generation', status: 'failed', errorName: 'Error', response: 'provider body' });

  assert.equal(logger.level, 'info');
  assert.equal(logger.snapshot().length, 2);
  assert.equal(logger.snapshot().at(-1).details.response, '[redacted]');
  assert.doesNotMatch(JSON.stringify(logger.snapshot()), /private prose|provider body/);
  assert.ok(calls.some(([level]) => level === 'info'));
  assert.ok(calls.some(([level]) => level === 'warn'));
  assert.match(calls.map(call => call.slice(1).join(' ')).join('\n'), /render_context_state/);
  assert.doesNotMatch(calls.map(call => call.slice(1).join(' ')).join('\n'), /private prose|provider body/);
});

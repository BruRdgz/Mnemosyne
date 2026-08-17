import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardView, dashboardMarkup } from '../../src/ui/dashboard.js';

test('Replay/offline controls are visible and the view carries the zero-cost generation state', () => {
  const markup = dashboardMarkup();
  for (const token of ['memoryGenerationMode', 'mnemosyne-import-rebuild', 'mnemosyne-generation-status', 'Replay recorded outputs']) {
    assert.match(markup, new RegExp(token));
  }
  const view = createDashboardView({ segments: [], entities: [], registers: [], conflicts: [], rebuildSessions: [] }, {
    generation: { mode: 'offline', operation: 'waiting', availableSegmentCount: 0, missingSegmentCount: 2, currentSegmentOrdinal: 2, totalSegments: 4 },
    tokenBudget: { sessionCap: 50_000, sessionSpentTokens: 12_000 },
  });
  assert.equal(view.generation.mode, 'offline');
  assert.equal(view.generation.availableSegmentCount, 0);
  assert.equal(view.generation.missingSegmentCount, 2);
  assert.equal(view.generation.operation, 'waiting');
  assert.equal(view.generation.currentSegmentOrdinal, 2);
  assert.equal(view.tokenBudget.sessionCap, 50_000);
  assert.equal(view.tokenBudget.sessionSpentTokens, 12_000);
});

test('Session view keeps provider and replay attempt accounting separate', () => {
  const view = createDashboardView({
    segments: [], entities: [], registers: [], conflicts: [],
    rebuildSessions: [{
      id: 'rb_0123456789abcdef', status: 'incomplete', plan: [{ segmentId: 'seg', status: 'failed' }],
      attempts: [
        { segmentId: 'seg', executionMode: 'live', credits: 10 },
        { segmentId: 'seg', executionMode: 'replay', replayedCredits: 10, credits: 0 },
      ],
    }],
  });
  assert.equal(view.rebuildSessions[0].attempts[0].credits, 10);
  assert.equal(view.rebuildSessions[0].attempts[1].credits, 0);
  assert.equal(view.rebuildSessions[0].attempts[1].replayedCredits, 10);
});

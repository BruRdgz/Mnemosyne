import assert from 'node:assert/strict';
import test from 'node:test';
import { compileExtractionRequest, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_PROMPT_VERSION } from '../../src/extraction/request-compiler.js';

const raw = (index, role, text, tokenCount = 2) => ({ index, role, text, tokenCount });
const memory = (id, firstIndex, lastIndex, synopsis, tokenCount = 3) => ({ id, firstIndex, lastIndex, synopsis, tokenCount });

function fixture(overrides = {}) {
  return compileExtractionRequest({
    target: { firstIndex: 10, lastIndex: 11, messages: [raw(10, 'user', 'You promised.'), raw(11, 'assistant', 'I remember.')] },
    stateAtStart: { text: 'Peter owes MJ honesty.', tokenCount: 4 },
    previousSummaries: [
      memory('S7', 6, 7, 'Peter hid the Felicia message.'),
      memory('S8', 8, 9, 'Peter promised MJ no more lies by omission.'),
    ],
    olderMemories: [memory('S2', 2, 3, 'MJ values direct disclosure.')],
    rawPrelude: [raw(8, 'user', 'Tell me the truth.'), raw(9, 'assistant', 'I promise.')],
    ...overrides,
  });
}

test('Phase 4: request includes state-at-start and every labeled historical region', () => {
  const request = fixture();
  assert.match(request.prompt, /STATE AT TARGET START — HISTORICAL CONTEXT ONLY/);
  assert.match(request.prompt, /Peter owes MJ honesty/);
  assert.match(request.prompt, /CHRONOLOGICAL PRELUDE/);
  assert.match(request.prompt, /RELEVANT OLDER MEMORY/);
  assert.match(request.prompt, /RAW PRELUDE/);
});

test('Phase 4: target is exact and unmistakably the only source of new facts', () => {
  const request = fixture();
  assert.match(request.prompt, /TARGET MATERIAL — ONLY SOURCE OF NEW FACTS \(10\.\.11\)/);
  assert.match(request.prompt, /You promised\./);
  assert.deepEqual(request.regions.target.indices, [10, 11]);
  assert.match(request.systemPrompt, /ONLY facts established by TARGET/);
});

test('Phase 4: “you promised” can be resolved from chronological context', () => {
  const request = fixture();
  assert.ok(request.prompt.indexOf('promised MJ no more lies') < request.prompt.indexOf('You promised.'));
  assert.deepEqual(request.dependencies, ['S7', 'S8', 'S2']);
});

test('Phase 4: summary-bleed prohibition is explicit', () => {
  assert.match(EXTRACTION_SYSTEM_PROMPT, /Do not report a historical-context event as if it occurred in TARGET/);
  assert.match(EXTRACTION_SYSTEM_PROMPT, /Historical sections are CONTEXT ONLY/);
});

test('Phase 4: future summaries, memories, and raw messages are excluded', () => {
  const request = fixture({
    previousSummaries: [memory('S8', 8, 9, 'valid past'), memory('S12', 12, 13, 'Alice later reveals the lie')],
    olderMemories: [memory('S20', 20, 21, 'future revelation')],
    rawPrelude: [raw(9, 'assistant', 'past'), raw(12, 'assistant', 'future raw')],
  });
  assert.doesNotMatch(request.prompt, /later reveals|future revelation|future raw/);
  assert.deepEqual(request.dependencies, ['S8']);
});

test('Phase 4: independent sub-budgets are enforced without borrowing', () => {
  const request = fixture({ budgets: { stateTokens: 3, chronologicalTokens: 3, historicalTokens: 0, rawPreludeTokens: 2 } });
  assert.equal(request.regions.state.included, false);
  assert.ok(request.regions.chronological.tokenCount <= 3);
  assert.equal(request.regions.historical.tokenCount, 0);
  assert.ok(request.regions.rawPrelude.tokenCount <= 2);
  assert.equal(request.regions.target.tokenCount, 4, 'target remains complete');
});

test('Phase 4: duplicate chronological memory is not repeated in older retrieval', () => {
  const duplicate = memory('S8', 8, 9, 'same memory');
  const request = fixture({ previousSummaries: [duplicate], olderMemories: [duplicate, memory('S2', 2, 3, 'older')] });
  assert.deepEqual(request.regions.chronological.ids, ['S8']);
  assert.deepEqual(request.regions.historical.ids, ['S2']);
});

test('Phase 4: structured schema and prompt version travel with request', () => {
  const request = fixture();
  assert.equal(request.promptVersion, EXTRACTION_PROMPT_VERSION);
  assert.equal(request.jsonSchema.name, 'mnemosyne_episode_extraction');
  assert.equal(request.jsonSchema.strict, true);
  assert.equal(request.jsonSchema.returnInvalid, true);
  assert.equal(request.jsonSchema.value.title, 'MnemosyneEpisodeExtraction');
});

# Mnemosyne

Mnemosyne is a per-chat narrative memory, state, retrieval, and prompt-virtualization extension for SillyTavern 1.18 or newer. The raw SillyTavern chat remains the source of truth; derived memory is always reconstructable and is never shared automatically between chats.

## Project status: experimental MVP / proof of concept

This repository is an experimental MVP generated with GPT assistance over a few hours to solve a concrete context-window problem. It is usable for local experimentation, inspection, and concept validation, but it is **not stable software** and should not be treated as production-ready. Keep backups of chats and memory artifacts before using it on anything important.

The current JavaScript implementation contains reinvented infrastructure, fragile behavior, and edge cases handled incrementally in a whack-a-mole fashion. The tests and safeguards document what was observed during this iteration; they are not a promise of a stable compatibility contract across SillyTavern versions or providers.

The central idea has nevertheless been validated on a real long chat: roughly **75K raw tokens can be represented by about 5–6K injected memory tokens** (approximately **25:1 compression**, depending on the selected retrieval and raw-foreground budgets). The next planned step is a deliberate, hand-written TypeScript rewrite now that the architecture and failure modes are understood. Until then, consider this repository a working proof of concept rather than a finished extension.

## Installation (POC)

Mnemosyne is source-distributed; there is no production bundle or package registry release yet. Use SillyTavern **1.18 or newer** and keep a backup of the user data directory before installing this experimental extension.

1. Download or clone this repository.
2. Copy the runtime files—`index.js`, `manifest.json`, `style.css`, `settings.html`, and the `src/` directory—into SillyTavern's extension directory as `data/default-user/extensions/Mnemosyne/`. Do not copy the repository's tests or local working notes.
3. Restart SillyTavern (or reload extensions), open the Extensions panel, and enable **Mnemosyne**.
4. Open a chat and enable **per-chat narrative memory**. Use `live` only after configuring a memory connection; `replay` and `offline` never make new memory-provider requests.

On Windows, the target normally looks like `C:\path\to\SillyTavern\data\default-user\extensions\Mnemosyne`. For development, Node.js **20 or newer** is required for the local test suite (`npm test`); the extension itself uses SillyTavern's runtime modules and does not require `npm install` to load.

This POC has no migration guarantee. To update it, replace the same runtime files, keep the chat's raw history and Mnemosyne metadata backed up, and verify the inspector before relying on a promoted memory.

## Configuration

The extension drawer exposes managed-context, reserved-headroom, raw-foreground, and per-region state/register/chronological/associative budgets, segment target size, provider-independent per-session and daily token caps, lexical/hybrid retrieval mode, an optional SillyTavern connection-profile ID for memory extraction, dedicated extraction temperature/top-P, automatic preemptive compaction, optional group participant selection, sensitive-preview collapse, and a temporary commitment age-out threshold. The raw foreground has a balanced 6,000-token default and an additional semantic reserve, so it cannot consume the whole managed context. Age-out only removes stale active commitments from projected prompts after the configured number of later segments; source candidates and raw history remain untouched, and `0` disables it. When enabled, opening a chat performs one bounded local audit and at most one pending compaction request; failed or stale ranges remain an explicit-resume boundary. Effective profiles can layer global defaults with default/character/group/chat scopes and narrative-free per-chat overrides; the inspector reports which scope supplied each setting. Structured extraction is attempted first and a conservative tagged fallback is retried once. Embeddings are optional; lexical/entity retrieval remains available without them.

Defaults favor one background batched extraction per committed segment and zero Mnemosyne generative calls on ordinary turns that do not need compaction. Opening a chat may run the single bounded check described above. Current user content stays lossless. Lower-priority retrieved or weak-inference material is dropped before required raw context.

## Storage and repair

Portable semantic memory lives in the current chat's `chatMetadata.mnemosyne` envelope. Rebuildable acceleration data—token counts, lexical index, and replay checkpoint—uses per-chat localForage storage. Token entries are keyed by the active ST tokenizer identity and message fingerprint; indexes require an exact semantic fingerprint; checkpoints still pass replay-prefix validation. A separate append-only global token ledger supports the optional daily cap without storing narrative text. These artifacts are disposable and never outrank portable memory. No semantic memory is stored in global extension settings, and no network telemetry is emitted.

The dashboard provides a searchable, paginated timeline with short source-range/integrity badges, explicit read-only source inspection, a **Jump to chat** focus action, page selection, and ordered bulk pin/unpin/exclude/restore actions, plus character, relationship, register, conflict, retrieval, prompt/token, and metrics inspectors. Generated synopses can be edited, pinned, excluded, or regenerated; active commitments can be manually retired with confirmation. Retirement marks the semantic transition `obsolete`, removes the commitment from projected state and retrieval keys, and preserves the raw chat, original extraction output, and provenance. JSON export/import is restricted to the active chat identity and schema version. Full rebuild preserves manual edits by source fingerprint; “Indexes only” performs no model extraction. Adaptive rebuild analysis exposes economic/fast/safe/balanced alternatives and a plan selector before confirmation. Default diagnostic export excludes narrative text.

### Local telemetry

Routine metrics and operational logs remain local. The logger records lifecycle, render-context, persistence, provider-route, request-ID, finish-reason, token-usage, and failure diagnostics in a bounded in-memory ring; narrative fields are redacted before the browser console or snapshot sees them. Configure `telemetryEnabled`, `telemetryLogLevel` (`debug`, `info`, `warn`, `error`, or `silent`), and `telemetryMaxEntries`. Set the level to `debug` temporarily when diagnosing rendered context state; it reports summarized/raw/unobserved counts without message text and never makes a network request.

### Historical backfill for existing chats

Historical rebuilds use a blue/green session stored separately from the active envelope. Every provider response or error is written first to immutable localForage storage (and to an append-only sidecar in the operational script), then the normalized candidate and session metadata are saved before another request may start. Portable-envelope mutations publish in memory only after the durable metadata write succeeds, so a failed save cannot leave a phantom candidate. An incomplete session never replaces or enters the active prompt; promotion is explicit and atomic after full fingerprint-valid coverage.

The rebuild planner treats a user run plus the following assistant/group response as an indivisible `TurnBundle`. New analyses use a local adaptive dynamic program: contiguous segments contain at most five bundles, projected input is kept below 80% of the extraction budget when possible, and economic/fast/safe/balanced alternatives are shown before confirmation. Existing valid ranges with exact source fingerprints are reused, including ranges larger than the new bundle cap. The selected plan and its calibration snapshot are frozen in the blue/green session; resuming never repartitions it. Legacy sessions retain their original greedy plan. It sends at most one request at a time with a 3-second default cooldown; explicit rebuild/replay/repair and automatic compaction share this single-flight guard. It caps completion output at 4,000 tokens and targets at most 110,000 nominal input tokens across a clean rebuild. Provider quota, rate-limit, authentication, and availability failures stop immediately without automatic retry. Resume begins at the first failed/pending range and preserves all prior green ranges and raw attempts.

The public runtime API exposes `startRebuild`, `resumeRebuild`, `getRebuildSession`, `exportRebuildSession`, `importRebuildSession`, `replayRebuild`, `promoteRebuild`, `deleteRebuildSession`, and `retireCommitment`; `runBackfill` remains the compatibility facade. Session deletion is only available as a specific manual action with dashboard confirmation.

Memory generation has three explicit modes. `live` is the default and may call the configured memory provider; `replay` consumes only immutable responses already recorded for a compatible chat/session; `offline` performs no memory generation and leaves new historical ranges raw. The inspector shows the active mode, available/missing replay ranges, and `0` new requests/tokens for replay and offline. Importing a session is explicit and validates chat identity, source fingerprints, configuration, and raw-attempt references before storing anything. Story generation through SillyTavern remains independent of these memory modes.

The session and daily caps use total logical tokens: `nominal input + output`. Before each live memory request, Mnemosyne reserves the locally counted rendered input plus `max_tokens`, so a request that could cross a configured cap is rejected before reaching the provider. After completion, the reservation is replaced by provider-reported usage or an explicitly labeled local estimate. Cached input still counts toward the generic token cap because caching changes billing, not logical context consumption. A value of `0` means unlimited. Historical credit estimates remain available only as optional rebuild audit data and never control execution.

For a provider-free qualification against a live SillyTavern tokenizer, run `node scripts/qualify-live-rebuild.mjs --chat "<absolute chat jsonl>"`. It performs no provider requests and writes no files. The operational `backfill-live-chat.mjs` utility snapshots the candidate after every metadata transition and appends raw attempts beside that checkpoint; `--apply` is required to update the chat's Mnemosyne metadata.

To replay an exported/checkpointed rebuild with its append-only attempt log, use `node scripts/backfill-live-chat.mjs --chat "<absolute chat jsonl>" --replay-artifact "<checkpoint.json>" --replay-attempts "<checkpoint.json.attempts.jsonl>"`. The utility imports the compatible session and never calls the memory provider. Use `--offline` when planning raw-only operation without an artifact. A replay run records historical usage separately and consumes zero new provider tokens.

Open an existing chat and use **Historical backfill → Analyze chat** for a provider-free plan. Analysis is local: it counts the history older than the configured lossless raw foreground, plans atomic segments, and estimates the minimum/maximum model requests without calling a provider or writing memory. Ordinary chat opening also performs one bounded automatic compaction check when enabled; it never drains an entire historical rebuild silently.

Memory generations reserve enough output room for reasoning-capable providers. A fallback synopsis that ends mid-sentence is rejected as truncated, so its raw source remains eligible instead of being replaced by incomplete memory. When all ordinary ranges are covered, **Start / resume** automatically offers to retry isolated failed segments without rebuilding valid ones.

**Start / resume** processes missing historical segments in chronological order. The flow can pause or cancel after the current request, stops on the first provider failure by default, preserves manual/excluded memory, and never edits raw messages. Its compact panel shows progress and the latest result; **Export detailed report** deliberately exports every structured extraction output for offline inspection. Because that report contains narrative material, it is separate from the default narrative-free diagnostics export.

## Context virtualization and safety

Rendered chat messages receive an ephemeral read-only integrity badge for green, pending, stale, or excluded ranges; repair remains a separate confirmation-gated action.

After a prompt is compiled, messages covered by valid green memory and actually omitted from that prompt are greyed-out in the chat view. The state is ephemeral and read-only: raw foreground messages, stale/failed/pending ranges, and messages before a prompt observation remain normal. Hovering the message text reports whether it was omitted or retained in the last prompt.

Only `valid` memory whose source and TurnBundle fingerprints match the active edit/swipe/media branch may replace old raw messages for a generation. Omission is ephemeral through SillyTavern's `extra[context.symbols.ignore]` contract and covers every matching green range before the lossless foreground, even when that segment is not retrieved into the current prompt. `stale`, `failed`, pending, mismatched, and inactive-branch sources remain raw. Provider failure never authorizes raw deletion. Async extraction commits are guarded by chat ID and source fingerprint.

Mnemosyne 0.2 injects its context using SillyTavern's complete `setExtensionPrompt` contract as a system-role `IN_CHAT` prompt at the raw-foreground boundary. The block is explicitly historical data rather than instructions, and projected state is labeled as-of that boundary. The inspector displays position, depth, role, World Info scan status, reserved headroom, integrity state, and (after a final prompt event) observed content-token totals split between Mnemosyne and other prompt content. Cancellation is locally abortable even when a provider route ignores its signal.

Detailed execution and acceptance notes remain in local working files and are intentionally not tracked in this MVP repository snapshot. They treat input/output as separate token budgets, keep the active green baseline during rebuilds, and make replay/offline and persistence behavior explicit.

Turn integrity is checked locally on mutations and before virtualization. Exact and narrative hashes distinguish cosmetic newline/normalization drift from meaningful text, active-swipe, role, or media changes. Cosmetic drift refreshes local integrity metadata with zero model calls; meaningful drift marks the dependent suffix stale and raw-only without deleting the previous candidate. Targeted regeneration is blue/green: the paid candidate remains active until its one-range replacement is valid and atomically promoted. Ordinary automatic compaction uses the same raw-attempt journal as historical rebuilds.

Mnemosyne does not rewrite character cards, provide cross-chat/global memory, or estimate provider monetary cost without an explicit pricing source.

The inspector also exposes `Inject managed summaries into prompts`. Turning it off clears the Mnemosyne extension prompt for ordinary generations while retaining the portable envelope, integrity checks, and (when `autoCompact` and the selected generation mode allow it) local/replay persistence. This is an explicit context decision; it does not delete summaries or raw history.

## Metrics and benchmarks

Routine metrics are local and reject narrative-bearing fields. They report model/embedding calls, provider token/cache fields when exposed, critical-path stages, per-region context tokens, retrieval quality, replay/invalidation scaling, and storage footprint. Unknown provider cache usage remains `null`.

Run:

```text
npm test
npm run benchmark
npm run qualify:st-api
```

The benchmark writes `benchmark-results/latest.json` and prints the same machine-readable report. It uses a deterministic local 120-segment fixture; it does not claim live-provider, price, cache-hit, embedding-backend, or browser-heap qualification. Live Chromium heap is recorded separately when `performance.memory` is exposed.

`qualify:st-api` is a read-only local HTTP check for the installed SillyTavern public parser, interceptor, extension-settings, and metadata-save modules. It makes zero provider requests and writes no files; it does not replace the final browser-runtime command invocation or real prompt qualification.

## Known limitations

- Provider structured-output and usage metadata vary; malformed output can degrade to the tagged fallback, and dual failure leaves a failed segment plus raw source.
- No live embedding backend is bundled or required. Hybrid mode falls back cleanly to lexical retrieval when unavailable.
- Dynamic associative retrieval can reduce prompt-prefix cache stability; the stable chronological/state prefix changes only when its semantic inputs change.
- Exact SillyTavern card/lorebook/example/other-extension token itemization is not yet exposed by the installed ST build; 0.2 uses a visible conservative reserved-headroom fallback. The adapter accepts a complete, explicitly public prompt-breakdown hook from newer builds without importing private Prompt Manager state.
- Mnemosyne passively audits SillyTavern's final chat-completion prompt event after compilation, recording only occurrence count, system role, and observed/expected depth. A real generation with eligible green memory is still required to close the final Phase 17 placement evidence row; the fixture, pinned ST contract test, and live empty-memory UI smoke are green.
- The runtime lexical index covers synopsis, events, observations, state, private knowledge, relationships, commitments, threads, negatives, registers, interpretations, temporal evidence, and locations. Boundary state and registers use compact deterministic prose rather than JSON; register lifecycle and injection policy are honored.
- Retrieval uses BM25 length normalization, a small bounded recency contribution, exact thread/commitment/entity/register boosts, and explicit active-speaker/foreground-participant reasons. Recency only reranks already relevant candidates and cannot make unrelated recent memory eligible.
- Exact pre-generation card/lorebook/example/other-extension token itemization is not available through SillyTavern 1.18's public extension context. Mnemosyne measures active public `extensionPrompts` values when possible, excludes its own injection, and keeps an explicit conservative reserve for the unexposed remainder instead of importing private Prompt Manager internals. A newer build may opt into the adapter's complete public breakdown hook; it is marked exact only when the producer declares the pre-generation result complete.
- Cross-chat memory and automatic character-card updates are intentionally out of scope.
- The drawer edits the most common current-chat profile overrides and, for the active character/group, sanitized settings-backed profile definitions. Eligible rendered chat messages also receive a temporary, confirmed repair action that starts blue/green regeneration without auto-promotion. When SillyTavern exposes its public slash parser, Mnemosyne also registers provider-free `/mnemosyne-status` and `/mnemosyne-audit`, mode/pause controls, explicit replay/resume, and confirmed targeted-repair commands; the dashboard remains the fallback when that parser is unavailable.

# 05 · Events, progression, ghosts and persistence

## Data-driven content

Author six route records and eighteen event records outside core logic. An event identifies its route, mode, car restrictions if any, start/finish conditions, checkpoints, medal targets, rival recording, rewards and presentation preset. Schema-validate records at build time. Invalid references must fail validation rather than appear as broken event buttons.

Drift Attack medals compare legal banked score; Time Trial medals compare validated active simulation time; Rival Ghost medals compare against explicitly tiered recorded targets. Use measured developer runs and new-player tests to set medal thresholds. Do not invent arbitrary “gold” scores before the physics and route are playable.

## Run lifecycle

Use `PREPARE → COUNTDOWN → ACTIVE → FINISHING → RESULTS`, plus explicit interrupted/aborted states. Every run gets a unique run ID and immutable event/tune/version metadata. Only ACTIVE advances event time or scoring. Checkpoint crossing is direction-aware and ordered. A reset cancels the current competitive run unless an event explicitly defines a penalty; this choice is visible and consistent.

Finishing is a transaction: validate route completion, bank eligible score, calculate medal, update bests, record reward application, persist, and show results. Re-entering results, double-clicking continue or retrying a failed save must not repeat the reward. Settings changes and cosmetic changes must not mutate an in-progress record.

## Progression

Use the unlock sequence in `01_PRODUCT.md`. Keep achievement/unlock evaluation deterministic from stored completed-event records. Store the highest earned medal per event, never silently downgrade it. Replays and photo mode do not earn currency. Test every unlock by both ordinary play and fixture-based state setup in the QA build.

A player without working storage can still drive and finish events; a non-blocking save-status message explains that progress is session-only. Do not repeatedly prompt for permission or block play. Unknown future save versions must not be overwritten with defaults.

## Best-run ghosts

Record route-relative or world-space transform snapshots and enough wheel/steering presentation state to render a ghost without live physics. Include build/schema/tune/event hashes and duration. A ghost has no collider and no scoring effect. It is clearly labeled “Personal best” or “Recorded rival.” Do not call an authored recording a live player.

Target 15 samples per second for a full-run ghost with interpolated playback. Quantization/compression is permitted if it preserves clean road placement and a smooth silhouette. Keep at most one stored personal-best ghost per route. All serialized save data, including encoding overhead and ghosts, must remain within the internal 512 KiB budget; use the actual UTF-8 byte count, not JavaScript string length.

If a ghost exceeds its budget, reduce noncritical precision/sample density or keep its timing metadata and a session-only recording. Never destroy progression to fit a ghost. Incompatible ghosts are safely ignored with a clear reason; personal best time/score metadata can remain valid only under documented compatibility rules.

## Twelve-second replay

Maintain a bounded 12-second, 30 Hz ring buffer of the player's visual transforms and necessary VFX trigger metadata. Replay rendering must not re-simulate scoring, physics rewards or platform gameplay events. Freeze/copy the buffer before entering replay so the playback does not overwrite itself. Use a modest set of authored follow/orbit/trackside cameras with occlusion protection.

Photo mode uses the actual game scene, with HUD toggle, orbit/pan bounds, exposure within approved limits and a screenshot action. Do not require persistent `preserveDrawingBuffer=true` throughout gameplay merely to support a capture. Provide a graceful browser-permission/download fallback. Screenshot output is a feature to implement, not an asset already included here.

## Persistence architecture

Use a versioned `SaveStore` interface. The standalone build uses guarded browser storage. The Poki adapter uses supported browser storage patterns after initialization and handles failures. The CrazyGames Full build uses its Data module as the authoritative progression store, including guest saves, rather than writing a competing local save on that platform. Its documentation requires initialization and currently describes a 1 MB data ceiling. [S08]

The internal 512 KiB budget is intentionally lower and applies to all builds. Keep schema version, monotonic revision, bests, unlocks, selected cosmetics, settings and bounded ghost data. Use parse validation, migration tests and a retained previous valid snapshot where the storage mechanism permits it.

Account changes, concurrent tabs or late storage initialization must not overwrite a loaded account save with blank defaults. Treat account-change behavior as a platform adapter integration test. While an authoritative platform store is unavailable, use a clearly marked ephemeral session rather than silently establishing a second persistent truth. Never promise cross-portal cloud synchronization.

## Required regression cases

Corrupt JSON, unsupported version, empty store, denied storage, quota exhaustion, abrupt tab close after finishing, refresh during reward processing, duplicate finish event, ghost hash mismatch, reward callback duplication and account data arriving late. A no-op storage mock proves error handling only; real browser and portal tests are separate evidence.

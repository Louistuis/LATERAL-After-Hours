# goal.md
## The game we are commissioning

Build **LATERAL: AFTER HOURS**, an original, premium 3D drift-racing browser game. A player opens it, takes control almost immediately, feels a believable rear-wheel-drive car rotate into a slide, catches it with countersteer, and links the next corner while convincing light moves over the bodywork. The game should be exciting in motion, not merely attractive in a garage screenshot.

The visual reference is the photographic confidence and responsiveness of a high-end automotive game such as Forza Horizon. Use that as a craft benchmark, never as permission to copy its branding, vehicles, maps, UI, music or assets. Our product is a dense, authored browser racing playground rather than an imitation of a huge console open world.

## Mandatory production office

The existing main session is the sole **GPT 6 Astra** boss, with authority over every Sol and every Luna. Under it are **three GPT 6 Sol hands-on senior developers/advisors**; each supervises **two GPT 6 Luna specialist workers**. The hierarchy is **Astra → Sol → Luna**, six Lunas and ten agents total. Astra may directly inspect, instruct and correct any Luna while keeping its Sol informed. Sols must implement difficult production work as well as supervise. See `CHAIN_OF_COMMAND.md`. Actual sessions/model routing must be verified, never simulated.

## What the finished release must contain

| Player-facing promise | Minimum complete release |
|---|---|
| A real driving game | Four-wheel suspension/contact model, progressive tire slip, throttle-controlled oversteer, countersteering, handbrake, collisions and fast recovery |
| Distinct cars | Three original RWD cars with different silhouettes, mass distribution, power delivery, audio and handling |
| A place worth exploring | One connected coastal region containing Harbor Works, Ridge Pass and Coastline; about 4–6 km of unique drivable road plus a practice pad |
| Reasons to keep driving | Six authored routes, 18 event configurations, three medal levels per event, free drive, tutorial and local bests |
| Competition | Drift Attack, Time Trial and Rival Ghost events; rivals are explicitly recorded ghosts, not fake online players |
| A personal garage | Eight paint choices per car, three shared wheel styles, four authored liveries per car, three handling presets per car and reversible tuning |
| Premium presentation | Convincing car paint and rubber, road roughness, stable lighting, reflections, readable tire smoke, skid marks and polished camera motion |
| A satisfying finish | Results, rewards, instant retry, a 12-second replay and a photo mode that captures the actual renderer |
| Complete usability | Keyboard, gamepad and touch; mobile/tablet layouts; saved settings/progression; tutorial skip/replay; accessibility controls |
| A distributable product | Source repository, editable asset sources, documented builds, platform adapters, test evidence, licensing ledger and submission packs |

No claimed feature may be a decorative button, hard-coded screenshot, placeholder screen, fake leaderboard or unimplemented stub.

## Quality priorities

Preserve this order when a trade-off is necessary: **driving feel → stable frame pacing → believable car/world presentation → instant entry → replayability → optional spectacle**. Reduce an expensive visual effect before reducing simulation consistency. Improve a small, dense environment before expanding an empty one. Low settings must still look intentionally art-directed.

Target 60 FPS on the defined mainstream reference devices and a stable 30 FPS compatibility tier on the defined weaker devices. Chrome is the primary profiling target; Edge, Firefox, Safari, Android Chrome and iOS Safari are release test targets. Exact devices, render resolutions and percentile gates are in `specs/08_PERFORMANCE.md`. These are development targets requiring real measurements.

Aim for an initial playable transfer of at most 8 MB and a complete shipped bundle of at most 120 MB. A tiny loading scene does not count as gameplay; the first driving area must actually work. Download and render budgets are internal targets, separate from the current portal requirements in `specs/09_PLATFORMS.md`.

## Definition of “fully done”

**OWNER_READY** means the full game is implemented, its private owner-review build is browser-testable, every pre-owner requirement in `contracts/qa-gates.json` passes, two clean core-regression runs have evidence, no known P0/P1/P2 defects remain, and A0 has independently reviewed the running candidate. Missing internal hardware/testing remains UNTESTED/BLOCKED, never PASS. No prompt can certify the absence of all undiscovered bugs.

The owner then personally tests a normal career and an unrestricted all-content sandbox with isolated saves, every car/route/event/cosmetic, diagnostics, reset/tuning tools and local bug-report export. Give a verified private preview when supported plus a tested local prebuilt package, controls and exact launch instructions. The game must not depend on a portal account or ad service for private testing.

**OWNER_APPROVED** requires the owner's actual decision on a specific tested candidate after feedback/fixes. **SUBMISSION_READY** additionally requires the selected portal's actual checks, rights and compatible terms. **PUBLISHED** requires the separate authorized public action and portal acceptance. Prepare all target builds; never impersonate these external approvals. See `OWNER_TESTING.md` and `specs/12_RELEASE.md`.

## Explicitly outside the base release

No real-time multiplayer, chat, third-party accounts, paid currency, licensed real-world cars, deformable-body destruction, full cockpit simulation, gigantic procedural map, continuous day/night cycle, mandatory ray tracing or mandatory WebGPU. These are expansion candidates only after the base release passes its gates. There are no runtime LLM calls or player-facing AI-service costs in the game.

## Instruction to the boss

Build the game, not another proposal. Use the handoff to make executable tasks, integrate working code frequently, produce a playable build at each milestone, and continue fixing measurable failures. Do not declare success because files exist. Judge what the player sees, hears and controls.

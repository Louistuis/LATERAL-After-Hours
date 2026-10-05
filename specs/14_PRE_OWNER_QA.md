# 14 · Studio QA before personal owner testing

## Meaning of the gate

The quality target is an exceptionally polished, smooth, complete game. Operationally, OWNER_READY means **all frozen pre-owner acceptance requirements pass, no known open P0/P1/P2 defects remain, independent reviewers inspected real execution, and the delivered candidate has reproducible evidence**. It is not a mathematical guarantee that no undiscovered defect exists.

The authoritative required-ID list is `contracts/qa-gates.json`. Do not remove IDs, downgrade severities, exclude a failing device, delete test cases or loosen performance targets to obtain a pass. A mandatory requirement change needs the owner's recorded approval, preserved previous requirement and retesting. Missing hardware/tools remain UNTESTED/BLOCKED. An early WIP may be shared with truthful limitations but cannot be called the final owner-ready handover.

## Accountability and independence

A0 owns final quality, cross-department fixes and the owner invitation. S1 signs off driving/scoring/content integration; S2 signs off in-motion rendering/assets/performance; S3 signs off UX, lifecycle, storage, delivery and whole-game review. Lunas write their subsystem tests and fix defects. L6 orchestrates test automation and evidence; it is not the only tester.

Authors cannot be final reviewers of their own patch. Sol-authored work is reviewed by another existing lead or A0. A0-authored work is reviewed by a Sol. A0 must inspect the running candidate with browser tools and real inputs where available, not merely read screenshots or reports. Preserve the ten-agent roster rather than spawning a separate QA army.

## Required test coverage

| Layer | Minimum proof before owner readiness |
|---|---|
| Static/build | Clean install; strict typecheck; lint; unit/integration suite; content schema, asset provenance and missing-file validation; all five builds |
| Driving | Ground contact, full drivetrain, initiation/sustain/transition/recovery, reverse/braking, reset, collision/seams, all cars and handling presets, render-rate parity |
| Content | All 18 events completed through valid input-driven gameplay; all 3 cars driven over each of the 6 routes; all three event modes, both lighting presets and each graphics preset covered |
| Experience | Every button/action; authentic tutorial/career/rewards; garage; all cosmetics; save reload; ghost; 12-second replay; photo capture; keyboard/gamepad/touch and focus/disconnect cases |
| Resilience | Hidden tab, pause composition, context loss, missing assets, corrupted/denied/full/future saves, canceled transitions, stale/duplicate callbacks, rapid retries and repeated scene changes |
| Visual/audio | Continuous driving and representative stills in every district; tire contact, paint/road/reflections, smoke/LOD/shadows, car distinction, engine/tire seams, interruption recovery |
| Performance | Existing fixed-tier frame gates, real-network cold-load tests, required real-browser/device matrix, mobile sustained run, desktop soak and 20 scene swaps |
| Owner package | Prebuilt static launch from clean extraction with spaces; all-content sandbox; real career; isolation; local export/import/report; no dependency on portal services |
| Production safety | Review/debug tools absent from all four production targets; correct SDK/network allowlist; relative assets, correct MIME/decoders; no secrets |

Pairwise coverage may be used for combinatorial settings interactions only after every explicitly required car/route/event/input/preset has individual coverage. Document the actual cases rather than implying every possible permutation was tested. Test both owner-review and production gameplay paths. Debug commands may set up a fixture, but may not award a win, inject a medal or set the pass variable instead of driving the test.

## Two clean core-regression runs

After fixes and code/content freeze, create the final owner-review artifact, record its SHA-256 and candidate identity, and execute two clean core-regression runs against that exact artifact. Use separate fresh browser/profile contexts and independent review; at least one is driven/reviewed by a different existing agent than the final integration author. Record each run's command/scenario set, browser, timestamps, result and raw artifacts. Never turn a retry into an unrecorded replacement of a failure.

Core regression includes boot → tutorial/control → drift → event finish → results/retry → garage → save/reload → sandbox switch → scene switch → replay/photo → exit/reopen, plus lifecycle/storage failure checks and production-stripping tests. Required content, device, visual and benchmark dossiers must also correspond to the same final source/content identity. A rebuild or relevant change invalidates affected evidence and both final core runs; regenerate/retest the final candidate rather than reusing old green logs.

Both clean runs must pass with zero failed or silently skipped mandatory cases. The full benchmark/device matrix does not have to be repeated twice without cause; its final-version evidence remains required. Store truthful skipped/blocked results rather than inventing data.

## Defect loop

Record an ID, severity, candidate, steps, expected/actual behavior, evidence, owner, fix commit and independent verification for every issue. P0 is data/security/integrity catastrophe; P1 is a crash, core flow or mandatory gate failure; P2 is noticeable recoverable gameplay/usability/visual breakage; P3 is minor cosmetic polish without functional impact.

Known open P0/P1/P2 defects block OWNER_READY. Keep P3 issues visible in the handover. A failed mandatory criterion blocks independently of its bug label. Fix at the lowest responsible layer; add a regression case; have another agent review; rerun affected tests and final core checks. The owner is not the substitute for the team's first serious playtest.

## Evidence manifest and checker

Populate `templates/QA_RESULT_MANIFEST.json` into `evidence/owner-ready.json`. Every pre-owner acceptance row needs PASS, the final candidate's build and commit, reviewer/author IDs, and hashed real evidence paths. Include separate run artifacts, open defects, independent department reviews and the final A0 review. Use:

```sh
python3 tools/check_owner_ready.py --manifest evidence/owner-ready.json --root .
```

This checker is a consistency/evidence-integrity gate, not a game test runner and not a semantic proof that a log is true. It rejects missing evidence, mismatched hashes, wrong identity, self-review, missing required rows, non-PASS states, open serious defects and incomplete final review. The team must first actually execute and inspect the tests that generate the evidence. Do not hand-author fabricated logs to satisfy a parser.

## Browser honesty and later stages

Playwright Chromium/Firefox/WebKit projects are useful automation, but Playwright's Firefox and WebKit are patched automation builds, not branded Firefox/Safari certification. Test real browser/device requirements separately and record actual version, hardware, OS, graphics backend and resolution. Software rendering/headless emulation cannot certify real GPU frame pacing. [S21]

Internal local SDK tests run before owner review. Real Poki Inspector and CrazyGames previews are separately recorded under POR-01/POR-02/POR-03 when authorized. They are not replaced by mocks; private owner review does not require a portal account. [S06, S17]

The five-person real-human onboarding study remains a requirement before the relevant final submission, after personal owner review if necessary. Agents cannot impersonate testers. Owner acceptance, actual portal permissions and publication are external decisions tracked separately, not missing internal tests renamed as completed.

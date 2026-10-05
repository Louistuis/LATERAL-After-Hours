# Acceptance criteria · Revision 2.0

All rows remain required at their declared stage. They start **NOT_RUN**. `contracts/qa-gates.json` explicitly separates internal OWNER_READY, later owner acceptance, named-target portal readiness and actual publication. A partial private WIP is not a passed gate.

The pre-owner set includes all mandatory internal real-browser/device/performance checks. The external five-human study, marketing approval, personal owner approval, live portal previews and public decisions are later stages, not silently waived or falsely passed. SDK-01/02/03 are local integration checks; POR-01/02/03 are actual authorized platform checks.

| ID | First gate | Accountable | Pass condition | Required proof |
|---|---|---|---|---|
| ORG-01 | G0 | A0 | Exact 1 Astra / 3 Sol / 6 Luna roster mapped to real host sessions; unsupported routing explicitly blocked | Roster, host model mapping and actual session records |
| ENG-01 | G0 | A0 | Clean repository bootstrap with pinned dependencies and documented reproducible setup | Clean-install, typecheck, test and build logs |
| ENG-02 | G0 | A0 | Shared units, timing, ownership, platform and save contracts reviewed before parallel integration | Contract review and version record |
| DRV-01 | G1 | S1 | Four-wheel contact/suspension and force-based drivetrain produce stable grounded driving | Physics fixture tests and telemetry |
| DRV-02 | G1 | S1 | Throttle oversteer, countersteer, transitions, braking and handbrake are physically responsive | Input-driven skidpad/slalom video and telemetry |
| DRV-03 | G1 | S1 | Rest, reverse, impacts, landing, reset and road seams do not produce explosions or stuck controls | Edge-case fixture suite |
| DRV-04 | G2 | S1 | Same-build scripted run at 30/60/120 render Hz differs by <=1% in score and <=0.5 m final position on a 60-second fixture | Raw repeated-run comparison, fixed simulation step |
| SCO-01 | G2 | S1 | Drift eligibility, chain transition/banking and collision/reset consequences follow validated rules | Scoring unit tests plus HUD recording |
| SCO-02 | G3 | S1 | Donuts, wall riding, reverse, shortcuts, airborne spin and paused time cannot exploit event scoring | Adversarial scoring suite |
| CAR-01 | G3 | S2 | Three original, visually distinct cars with working wheels/lights and approved LOD/material assets | Three-car captures, asset manifests and license review |
| CAR-02 | G3 | S1 | Three cars and their Grip/Balanced/Drift presets have demonstrably different, stable handling | Same-fixture tune comparisons and reviewer notes |
| WLD-01 | G3 | S2 | Three connected districts and about 4–6 km of unique driveable road with valid collisions | Map/source-length report and uninterrupted traversal |
| WLD-02 | G3 | S2 | Six distinct physical routes with legal checkpoints, respawns and readable boundaries | Route validator and full-route drives |
| EVT-01 | G3 | S1 | All 18 event configurations are completable with correctly ordered checkpoints and mode-specific results | Event validation plus completion matrix |
| EVT-02 | G3 | S1 | All events have three calibrated medals and coherent rewards/unlock progression | Measured calibration runs and progression tests |
| EVT-03 | G3 | S1 | Free drive, tutorial skip/replay, event retry and aborted-run behavior are implemented | End-to-end flow recordings |
| GAR-01 | G3 | S3 | Garage implements 8 paints per car, 3 shared wheel styles and 4 liveries per car | Cosmetic inventory validation and interactive walkthrough |
| GAR-02 | G3 | S1 | Tuning is bounded, reversible and never changes performance through cosmetics | Tune-reset/cosmetic parity tests |
| VIS-01 | G2 | S2 | Hero Harbor scene uses finished starter-car art, credible road/paint/rubber/glass and coherent lighting | Actual gameplay captures and independent visual review |
| VIS-02 | G3 | S2 | Both authored lighting presets work across all districts without mismatched exposure or baked lighting | Golden/Blue Hour comparison captures |
| VIS-03 | G2 | S2 | Smoke/skid marks follow contact/slip, remain readable and stay resource-bounded | Maximum-smoke capture and allocation test |
| VIS-04 | G5 | S2 | No visible primary placeholders, severe seams, floating wheels, harsh LOD jumps or broken shadows | Required ten-shot set and continuous drive |
| VIS-05 | G5 | S3 | Weighted quality rubric >=88 and every category >=80 with review evidence | Independent S2/S3 rubric and owner review package |
| CAM-01 | G2 | S3 | Chase/alternate cameras preserve visibility and recover smoothly from obstructions/resets | Camera obstruction, drift and reset videos |
| INP-01 | G2 | S3 | Keyboard, gamepad and simultaneous touch controls work with no stuck inputs | Real input-method tests and disconnection/focus cases |
| UX-01 | G3 | S3 | All required menus/actions are functional and readable at the specified viewport sizes | UI flow matrix, 640x360 and mobile/tablet captures |
| UX-02 | G3 | S3 | Accessible settings, visual focus, remaps, reduced motion and separate audio volumes persist | Settings persistence and accessibility checks |
| UX-03 | G7 | S3 | At least 4 of 5 real testers achieve a first drift within 60 s and complete an event without coaching | Anonymized observations; never substitute agent personas |
| AUD-01 | G3 | S3 | Distinct layered engine/tire/contact audio responds to gameplay without obvious seams/clipping | Audio capture, asset ledger and device listening review |
| AUD-02 | G4 | S3 | Autoplay/user-gesture unlock, ad mute and iOS interruption recovery preserve user preferences | Real iOS and lifecycle evidence |
| GHO-01 | G3 | S1 | Personal-best and recorded-rival ghosts replay smoothly, validate metadata and never collide | Ghost integration and incompatibility tests |
| REP-01 | G3 | S1 | Bounded 12-second replay and actual-renderer photo mode do not modify event state | Replay/photo capture and state-isolation tests |
| SAV-01 | G4 | S3 | Progression/settings persist through the correct authoritative store for each supported target | Reload and platform-save tests |
| SAV-02 | G4 | S3 | Corrupt/denied/full/future-version saves and duplicate rewards cannot destroy progress or block play | Storage failure/migration/idempotency suite |
| SAV-03 | G4 | S3 | Serialized save including ghost encoding stays <=512 KiB | Actual UTF-8 byte-size test at full completion |
| PER-01 | G5 | S2 | Every required reference device meets its defined frame-pacing gate | Raw device benchmark samples and environment metadata |
| PER-02 | G5 | S3 | First playable <=8 MB and defined cold-load p95 targets pass; bundle <=120 MB and <=800 files | Network traces, ten-boot tests and package-size report |
| PER-03 | G5 | S2 | Mobile sustained run and desktop soak/20 scene swaps show stable bounded resources | Thermal-session, soak and asset-lifetime evidence |
| PER-04 | G4 | S2 | Auto quality changes visual cost without affecting gameplay; low tier is coherent | Automatic-quality trace and fixed-input parity tests |
| BRW-01 | G5 | S3 | Required real browsers/devices and iframe sizes are tested with supported controls | Browser/device matrix with no substituted emulation claims |
| BRW-02 | G4 | S3 | Context loss, no WebGL2, failed downloads, resize and page hiding recover safely | Fault-injection browser tests |
| SDK-01 | G4 | S3 | Poki adapter passes current lifecycle, failure, storage and reward behavior checks | Current-doc local Poki adapter, lifecycle/storage/reward harness and failures; real Inspector is POR-01 |
| SDK-02 | G4 | S3 | CrazyGames Basic works with ads unavailable and no inactive reward affordances | Local CrazyGames Basic build, ads-disabled flow and network tests; real preview is POR-02 |
| SDK-03 | G4 | S3 | CrazyGames Full validates initialization, lifecycle, Data and ad callbacks | Local Full adapter initialization/Data/ad tests; real authorized Full preview is POR-03 |
| SDK-04 | G4 | S3 | Single-ad locking, pause composition and reward idempotency survive stale/duplicate/failure callbacks | Ad lifecycle adversarial suite |
| SDK-05 | G4 | S3 | Target builds contain only the appropriate SDK and allowed network requests | Network allowlist and bundle inspection |
| AST-01 | G3 | S2 | All runtime assets have permitted editable sources or documented delivery restrictions | Asset/source hash manifest and reproducible pipeline |
| AST-02 | G5 | S2 | Every shipped asset has approved provenance and no unauthorized trademarks/music/fonts | Completed asset-rights ledger and attribution review |
| REL-01 | G6 | A0 | Four reproducible independent targets and archives pass local release checks | Clean build, archives, hashes and boot smoke tests |
| REL-02 | G7 | S3 | Portal-specific covers/previews, screenshots, copy and controls match the shipped game | Validated media inventory and owner review |
| REL-03 | G6 | A0 | Stage-specific internal game deliverables and owner QA evidence handed over with zero known open P0/P1/P2 defects | Final deliverable matrix, evidence index and defect report |
| REL-04 | PUBLIC | A0 | Named-target owner authorization, compatible distribution terms and actual portal acceptance recorded before its publication | Human/portal decision records; missing access remains blocked |
| ORG-02 | G0 | A0 | Astra has final authority over every Sol/Luna; each Sol supervises two Lunas; direct interventions notify the Sol and preserve single-writer leases | Roster authority fields, instruction log and work-ownership review |
| ORG-03 | G3 | A0 | Every Sol personally authors tested production integration work and obtains independent review | S1/S2/S3 implementation commits, test results and non-author reviews |
| OWN-01 | G6 | S3 | A prebuilt owner-review target runs the complete game without portal account, ads, paid service or development server | Static served full-game walkthrough, network trace and complete content manifest |
| OWN-02 | G3 | S3 | Owner sandbox exposes every shipped car, route, event, cosmetic, tuning preset and lighting choice without grinding | Interactive all-content inventory and sandbox walkthrough |
| OWN-03 | G4 | S3 | Normal career, sandbox and portal saves/rewards/ghosts remain isolated; import/reset cannot silently destroy progress | Cross-profile contamination, oversized/corrupt import and reset/backup tests |
| OWN-04 | G4 | S3 | Owner tools provide safe selectors/resets, measured diagnostics, real-frame capture and bounded sanitized local bug-report export | Tools interaction, export schema/size/privacy tests and actual renderer capture |
| OWN-05 | G4 | S3 | Owner/QA hooks and unlock bypasses are absent from all four production dependency graphs and artifacts | Artifact scan, dependency inspection and production URL/flag negative tests |
| OWN-06 | G6 | A0 | Owner receives a tested local launcher and exact access instructions; any supplied private preview URL is actually verified reachable | Clean extraction-with-spaces launch, opened browser input test, access/lifetime notes and local fallback |
| QA-01 | G5 | S3 | Two clean core-regression runs pass on the same final owner-review artifact with zero failed/skipped mandatory cases | Distinct raw run artifacts, matching candidate SHA-256, fresh contexts and independent review |
| QA-02 | G5 | A0 | Department reviews and final A0 running-build inspection are real and no author finally self-approves | S1/S2/S3 reviewed evidence and A0 runtime inspection |
| QA-03 | G5 | A0 | No known open P0/P1/P2 defects or failed/untested mandatory internal checks at OWNER_READY | Full defect ledger, acceptance set, fix/regression history and gate result |
| QA-04 | G5 | S3 | All eighteen events are completed by valid gameplay and every car is driven on every route; required modes/input/lighting/quality settings covered | Input-driven runs, coverage matrix and genuine result telemetry; no forced wins |
| REL-05 | G7 | A0 | Human owner personally tests and explicitly accepts a specific candidate; fixes trigger regression and build-specific renewed acceptance | Actual owner feedback/decision record tied to commit/build/artifact hash |
| POR-01 | G7 | S3 | Poki target passes actual authorized Inspector/portal checks before its submission-ready claim | Real Inspector evidence and current target checklist, not local simulation |
| POR-02 | G7 | S3 | CrazyGames Basic passes actual authorized preview checks before its submission-ready claim | Real Basic preview evidence and stage-specific checklist |
| POR-03 | G7 | S3 | CrazyGames Full passes actual authorized Full preview/integration checks when the platform grants the relevant stage/access | Actual Full-stage access and preview evidence; Basic does not imply Full approval |

## Evidence and change policy

PASS requires real execution and reviewed evidence. FAIL is unmet execution. NOT_RUN is not attempted. UNTESTED is a declared environment not exercised. BLOCKED names the missing prerequisite. No mandatory failed/skipped/untested internal check can produce OWNER_READY.

No known P0/P1/P2 defect may remain at OWNER_READY. Disclose P3 limitations. A0 may propose a requirement change but cannot silently lower thresholds, remove a device or turn a required feature into optional. Preserve the owner-approved change record and previous requirement. See `specs/14_PRE_OWNER_QA.md`.

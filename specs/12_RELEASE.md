# 12 · Release, submission and owner handover

## Distinct end states

**Feature complete:** all specified systems/content implemented. **OWNER_READY:** all frozen internal/pre-owner requirements pass, no known P0/P1/P2 defects remain, and a tested private browser package is handed over. **OWNER_APPROVED:** the human owner accepts a particular tested candidate after personal testing and fixes. **SUBMISSION_READY(target):** owner approval plus that target's required human, rights, policy and actual portal checks. **PUBLISHED(target):** separately authorized public action, platform acceptance and an actual live listing. Never conflate these states.

Before G6, the studio must test the game itself rather than use the owner as its first QA pass. G6 is personal owner testing; G7 handles feedback and submission readiness. Missing required internal checks keep OWNER_READY blocked; missing external checks remain pending under their own stage. The binding membership is `contracts/qa-gates.json`.

## Reproducible outputs

Deliver a clean repository with lockfile, setup guide, content/asset pipeline, tests and build commands. Produce private `dist/owner-review/` plus independent `dist/standalone/`, `dist/poki/`, `dist/crazygames-basic/` and `dist/crazygames-full/` folders. Archive each target separately with an entry `index.html` at the expected root, relative game-asset paths and only that target's SDK setup. Private standalone output does not authorize public hosting under an exclusivity agreement.

The release checker verifies manifest completeness, absent secrets, no unwanted remote requests, size/file counts, license approval, removed debug/test code from the four production targets (permitted, isolated tools only in owner-review), no dev server dependency, correct target identity and a successful clean preview boot. Test MIME/decoder/WASM loading under a plain static preview and the portal environment. Do not assume the host serves precompressed assets with correct headers; validate the delivered behavior.

## Owner browser delivery before submission

Deliver the full `owner-review-package/` specified in `OWNER_TESTING.md` and `specs/13_OWNER_REVIEW.md`, with verified private URL when available and an always-included tested prebuilt local package. The owner can test every shipped feature without portal access, ads or grinding. Supply real QA evidence before inviting this review. A remote container's localhost does not establish an owner-reachable preview.

## Submission media

Create marketing assets from the finished game's actual car/world appearance, not from unrelated concept art. Art-directed cover compositions are allowed, but do not imply unimplemented mechanics or visual fidelity. Keep editable layout/capture sources and export the portal-specific variants.

Poki's square static thumbnail is full-bleed and at least 628×628; use a 1024×1024 working master and omit title text in its default variant. Prepare an animated thumbnail too, checking its exact current delivery requirements in the portal before final export. [S09]

CrazyGames currently requests 1920×1080 landscape, 800×1200 portrait and 800×800 square covers. Its preview guidance specifies silent, non-fast-forwarded 15–20-second footage up to 50 MB, with landscape and 2:3 portrait versions. Follow the current dashboard's exact export settings; do not add promotional slogans/store logos. [S10]

Also deliver six clean gameplay screenshots, a 30–45-second general trailer with properly licensed audio, a short description, a longer description, controls text, feature list, genre/tags and a concise onboarding explanation. The general trailer is separate from the constrained portal preview. Keep every claim grounded in shipped features.

## Platform package notes

Include integration version, measured initial/total sizes, supported device/orientation matrix, save behavior, ad opportunities, known issues, browser support evidence and preview instructions. Supply a completed portal checklist with links/IDs for actual authorized preview results. If no portal access was granted, label the artifacts locally validated and the portal checks pending.

## Publication decision gate

Before any public action the owner reviews: exact title, rights/attribution ledger, distribution terms, target portal(s), monetization behavior, privacy disclosures, screenshots/trailer, supported-device claims and known issues. Do not accept agreements, submit under the owner's identity or change a live listing without authorization. A technical pass does not waive commercial review.

## Operational handover

Provide versioned release notes, an architecture map, the editable-content guide, tune parameters, build/preview commands, test commands, dependencies/licenses, QA evidence index, benchmark report and a prioritized defect/backlog list. Document how to add a car, route, event, livery and language without rewriting the engine.

Preserve the previous approved release artifact and save-schema compatibility information. Define a rollback that does not corrupt newer progression. Test upgrade/migration fixtures before each update; incompatible ghosts can be invalidated deliberately while core progress is preserved.

## Later improvements, not hidden base-release gaps

Only after all base requirements pass, consider additional cars/routes, richer lighting, optional WebGPU rendering, global leaderboards or real-time multiplayer. Each new system requires its own cost, security, moderation, browser and platform review. Do not count a wishlist as delivered functionality.

## Owner's final evidence review

The owner should be able to open the build, drive all three cars, find all six routes, complete each event mode, switch input devices/settings, observe an authentic replay, reload saved progress and inspect genuine evidence. Anything that cannot be demonstrated remains incomplete regardless of the amount of generated code.

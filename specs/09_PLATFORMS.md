# 09 · Poki and CrazyGames integration

Checked against the primary-source documentation listed in `production/SOURCES.md` on **29 September 2026**. Recheck at implementation and submission. The following is a focused integration brief, not a replacement for the full current portal checklists or the owner's actual agreement.

## Distribution decision

Poki describes a preferred web-exclusive partnership and a non-exclusive licensing option for some games. The signed terms, not our ability to compile two builds, determine dual-portal distribution. Prepare both technical targets; do not publish either, accept terms or assume simultaneous release without owner authorization and compatible rights. [S01]

## Poki profile

Poki's documented checks include desktop/mobile/tablet support, responsive 16:9 embedding, incognito-safe storage, continued play with ad blockers, correct SDK events and both static/animated launch thumbnails. Reward UI must preserve a normal continue option, clearly identify video rewards and follow the portal's visual restrictions, including no green rewarded button. [S02]

Runtime fonts, libraries, images and audio must be bundled; unapproved external requests are blocked by default. No external account flow or chat is included. Keep all non-SDK networking disabled unless the portal explicitly approves it. [S03]

Initialize the current official HTML5 SDK, continue loading on initialization failure as documented, and signal genuine loading completion. Translate first player input and actual gameplay interruptions into deduplicated start/stop events. Commercial opportunities belong on valid return-to-play transitions, not arbitrary menu openings. Reward only a successful rewarded completion. Disable gameplay interaction during ad requests/playback and keep ad muting separate from player preferences. [S04, S22]

## CrazyGames profile

Current technical limits: total files ≤250 MB, file count ≤1,500, initial playable download ≤50 MB; mobile-homepage eligibility requires ≤20 MB initially. Use relative bundle paths. Chrome and Edge are expected; Safari/ChromeOS availability depends on working device support. SDK-integrated initial size is measured through the first genuine gameplay-start event. Basic Launch ads are disabled. [S05]

Use the documented HTML5 v3 loader and await `window.CrazyGames.SDK.init()` before SDK calls. Handle local, portal and disabled environments explicitly. The standalone build must not call a disabled CrazyGames SDK. [S06]

For Full, route progression through the Data adapter described in `05_EVENTS_GHOSTS_SAVES.md`. Basic must expose no dead rewarded-ad buttons. Use only the portal ad system; request interstitial opportunities at natural event boundaries, never on ordinary settings/shop navigation. Pause interaction while a request is unresolved. On actual ad start, mute game audio; terminal success/error releases only the ad-owned state. Rewarded errors grant nothing. [S07, S08]

## App state and SDK state are not the same

The application owns `BOOT`, `LOADING`, `READY`, `PLAYING`, `PAUSED`, `RESULTS`, `REPLAY`, `AD_REQUESTED`, `AD_PLAYING` and recovery states. The adapter maps semantic events to platform calls and deduplicates them. Do not forward every app-state change directly into a network event.

Use a pause-reason set and a single-ad mutex. Before requesting an ad, stop active gameplay, lock relevant input and record the context. The SDK's ad-start event adds temporary ad mute. A terminal callback releases the ad lock and reconciles whether the user is still hidden, manually paused or on results. A callback must not resume an event that already ended.

Reward requests carry an operation ID and expected reward. Apply a reward once, only on a valid successful terminal result for that operation. Duplicate/stale callbacks are ignored. Failed, unavailable, cancelled or unresolved requests do not grant rewards. A watchdog may offer recovery/reload, but must not blindly resume over an ad that could still be active.

No manual frequency manipulation in the Poki build. For every platform, use capability flags to control UI availability. Do not implement a fake ad-success fallback in production. Free gameplay remains accessible when SDKs or ads are unavailable.

## Build profiles

| Build | Adapter | Ads | Persistent progression | Purpose |
|---|---|---|---|---|
| standalone | No-network | None | Guarded local store | Local development/private review |
| poki | Poki | Valid SDK opportunities only | Poki-compatible browser store | Authorized Poki preview/submission |
| crazygames-basic | CrazyGames | Disabled; no reward UI | Documented supported save path, verified in preview | Basic evaluation |
| crazygames-full | CrazyGames | Full supported integration | Data module | Authorized full submission |

The Basic save path must be verified against the selected account capability in preview; do not assume Full-only progression features work before they are enabled. Maintain a deliberate storage selection, never two competing stores.

## Integration tests

Cover first input, no duplicated start/stop, pause/resume, settings, results, replay, page hiding, SDK loading failure, disabled environment, ad unfilled, successful reward, duplicate callback, late callback after reset, ad while hidden, user mute preservation, storage failure and returning player load. The game must not emit gameplay activity from a paused replay.

Test inside a representative local iframe and the real portal preview/Inspector. A mock proves reducer behavior only. Record portal tools' results and real network requests; a browser console message is not platform approval. Poki provides an Inspector with event logs and desktop/mobile testing; use it when access is authorized. [S17]

## Submission boundary

Create uploadable archives and media locally. Owner authorization is required for uploads involving their account, agreement acceptance, publication or changes to a live listing. If access is missing, ship the private artifacts with a precise outstanding checklist rather than claiming submission happened.

## Revision 2.0: private review is not a portal launch

Add a private owner-review target with no portal SDK dependency. Keep local adapter validation (SDK-01/02/03) separate from real authorized portal previews (POR-01/02/03). The latter occur during G7 for the selected target, after internal QA and personal owner testing. Poki, CrazyGames Basic and CrazyGames Full have independent submission gates; do not assume Basic publication authorizes Full, or that Poki distribution terms permit other portals. [S01, S06, S17, S24]

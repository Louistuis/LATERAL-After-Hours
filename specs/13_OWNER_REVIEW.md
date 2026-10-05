# 13 · Private browser-review implementation contract

## Build identity and isolation

Add `owner-review` as a fifth compile-time build target; retain the four production targets. All targets share driving, rendering, world, sound and content modules. Only owner-review imports `src/owner-tools/` and test-only adapters. Keep diagnostic UI, unlock bypasses, fault injectors and automation mutation hooks out of production dependency graphs and emitted code. Scan artifacts and exercise production URLs with test flags to verify that tools cannot be activated. A CSS-hidden button is not removal.

A0 owns target identity and shared contracts; S3 implements the experience/profile coordinator; L5 implements the tools panel; L6 implements save namespaces, exports, launcher and stripping tests. S1/S2 provide read-only telemetry and approved tune/scene selectors. Lease files before overlap.

Every built target exposes a non-sensitive version/build manifest containing version, commit, content manifest hash, target and tested configuration. The owner UI identifies its review build without intrusive always-on overlays. Gate evidence refers to the actual candidate identity, not a stale development server.

## Career versus sandbox

Use separate reviewed save namespaces, for example `lateral:owner:career:v1` and `lateral:owner:sandbox:v1`, with no implicit migration between them or into portal stores. Sandbox exposes all shipped items through an explicit access policy, not by mutating production economy functions. Sandbox results cannot become ranked/personal career records. Run IDs, reward operation IDs and ghost metadata record the profile.

Entering sandbox clears prior run timers, stuck inputs, pending rewards and scene transitions safely. Returning to career restores its selected car/settings/progress without applying sandbox changes. Confirm destructive reset and provide an export first. Reject oversized, malformed, future-version or incompatible imports without damaging existing saves. Never evaluate imported text as code.

## Owner tools

Ship visible selectors for all three cars, six routes, eighteen events, Golden/Blue Hour lighting, cosmetics and tuning presets. Provide practice spawn/reset, restart event, free drive, replay/photo access and safe return to garage. Changes that need a scene transition pause and reload the appropriate assets safely; no live mutation into impossible game states.

Provide optional FPS/frame-time, input, drift-angle, wheel-contact, tire-slip and resource overlays. Only show measurements that exist; GPU time remains unavailable when not actually supported. Normal benchmarking runs with intrusive diagnostics off and records any instrumentation overhead. Tools cannot change fixed simulation timing or quietly reduce visuals to make a performance test pass.

Expose failure-injection scenarios only in a separately marked QA section: failed asset, denied storage, ad-success/failure/duplicate callback simulator and context loss when supported. Simulated ads/rewards are test-only, never production callbacks. User-accessible review tools are not a requirement for online multiplayer or arbitrary code execution.

## Private launch and distribution

Build files run from an ordinary static HTTP(S) server with bundled assets, WASM, decoders and appropriate MIME handling. No dev server or backend is a runtime dependency. `npm run play` serves an already-built owner-review directory and opens the default browser; it must not silently install packages or rebuild on launch. Supply `build:owner-review`, `preview:owner`, `test:owner`, `test:release-strip` and `qa:owner-ready` as genuine repository scripts.

Use `tools/preview_build.mjs` as a starting local-only server or replace it with a documented equivalent validated against the completed output. Bind loopback by default. Do not expose the user's workspace or start an open public file server. For mobile testing, use an authorized private HTTPS/host preview or explicitly authorized LAN setup and document its limits; do not silently bind all interfaces.

If the work runs remotely, inspect whether a user-accessible port forwarding/preview tool exists. Verify its actual URL, content manifest and input-driven boot. Include expiry/lifetime limitations and local fallback. Do not fabricate a hosted preview, expose secrets, provision paid services or publish to a public domain without approval.

## Report/export contract

Bug reports are locally generated, user-initiated JSON. Include schema version, report ID, build/commit/content identity, timestamp, profile, scene/event/car, settings, sanitized recent diagnostics, user reproduction steps, expected/actual behavior and optional screenshot selected by the user. Bound logs to 60 seconds and exported JSON to 2 MB excluding optional image assets. Offer redaction/preview before export. No automatic remote telemetry.

Controls and diagnostics never silently alter the test session. Long sessions remain allowed. The completed review package must be checked from a clean extraction path including spaces, refreshed, closed/reopened and served with no development process running. Missing assets must return real errors rather than an HTML fallback that hides incorrect URLs.

## Required owner experience acceptance

The owner opens the package, drives immediately, tries every item through sandbox, tests authentic progression separately, changes settings, imports/exports a backup, captures a real frame, reports a problem locally and restarts successfully. A0 verifies this flow before declaring OWNER_READY. The human's personal acceptance is a later recorded decision, not simulated by A0.

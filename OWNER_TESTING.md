# Owner testing · What Louis must receive after the studio finishes

This is the delivery requirement for the implementation team. **This handoff ZIP is not the game.** The team must create and verify the playable package below before claiming OWNER_READY.

## Open it and drive

The first line of the team's owner-handover response should be the real private preview address, verified by opening the served candidate in a browser. When the host cannot expose a private preview, the first line must instead give the exact tested local startup instruction and playable-package link. Do not provide a remote localhost address as though it opens on the owner's computer.

Always include a prebuilt local browser package and tested launcher. No portal account, paid hosting, ad viewing, API key, compiling assets or editing code should be needed just to test the prebuilt game. A documented installed Node runtime is acceptable for a local static server; show its tested version and a clear prerequisite error. Do not tell the owner to double-click `index.html` through `file://`.

Required game-repository commands, implemented by the team:

```sh
# Use a prebuilt owner-review output. No npm install is needed for this server.
node tools/preview_build.mjs --dir dist/owner-review --open

# Equivalent convenience command once the delivered package scripts exist:
npm run play

# Developer rebuild, not required for a prebuilt personal test:
npm ci
npm run build:owner-review
npm run preview:owner
```

`tools/preview_build.mjs` in this handoff is a tested static-server helper, not a game. It refuses to start without a real `index.html` in the specified build directory. The implementation team must copy/integrate and test it against the completed game. Use the server's actual printed port; close it with Ctrl+C. Do not assume a URL is reachable after the host's preview lifetime expires.

## Two separate ways to test

| Profile | Purpose | Required behavior |
|---|---|---|
| Normal career | Experience onboarding and progression as a new player | Real tutorial, unlocks, rewards, saves and no debug advantages |
| Owner sandbox | Inspect every shipped feature immediately | All three cars, six routes, eighteen events, paints/wheels/liveries, tune presets and lighting choices available; no grinding, ads, paywalls or waiting |

Both use the same production gameplay/renderer/assets. Switching profiles never merges rewards, unlocks, leaderboards, ghosts or saves. Sandbox changes are marked and remain local. The production targets contain neither sandbox shortcuts nor diagnostic UI.

## Personal test controls

Provide a clear Owner Tools panel, not hidden console commands. It must support car/route/event/lighting selection, safe spawn/reset, bounded tuning with factory reset, graphics/input/audio/camera settings, telemetry and frame-time overlay, real-renderer screenshot capture, replay inspection, sanitized local bug-report download, and validated save export/import with confirmation before overwriting. Normal career can be reset only after explicit confirmation and an offered backup.

The owner may explore and replay freely. There must be no artificial test-session time limit. Exported reports include build identity, browser/device details available without intrusive collection, profile, car/route/event, relevant settings and bounded recent error/input history. Do not include account tokens, personal files or raw secrets. Nothing uploads automatically.

## Team checks before inviting personal testing

The full pre-owner acceptance set must be PASS with evidence. All cars/routes/events and critical flows must have been exercised, not just a start screen. Require independent reviews, actual input-driven gameplay, frame/load/soak measurements, working save recovery and two clean regression runs. Zero known P0/P1/P2 defects. Any P3 cosmetic limitation is disclosed. A0 signs the technical decision after checking the real running candidate.

Missing internal checks mean BLOCKED/WIP, not OWNER_READY. External portal approvals and the later real-human onboarding study are separate tracked stages; do not invent them or use their absence to hide an otherwise useful private build.

## Handover contents

The final `owner-review-package/` must contain `TEST_IN_BROWSER.md`, prebuilt `dist/owner-review/`, `tools/preview_build.mjs`, platform-appropriate launcher instructions, build/hash manifest, controls, content inventory, test/benchmark/evidence index, known issues, feedback form and save-backup instructions. The complete release handoff additionally supplies source, permitted editable assets, four production targets, rights ledger and portal materials.

The studio waits for the owner's actual feedback before owner approval. Fix reported issues, rerun affected checks and full core regression, and provide a new candidate identity and changelog. Approval of one candidate is not approval of an arbitrary later build or an automatic right to publish.

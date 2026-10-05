# 08 · Performance, loading and compatibility contract

All numbers in this file are **proposed internal targets**, not existing benchmark results. Portal limits are separately sourced in `09_PLATFORMS.md`. MB means 1,000,000 bytes; MiB means 1,048,576 bytes. Report bytes as well as human-readable units.

## Reference device matrix

| ID | Reference device to test | Browser | Preset / fixed benchmark render size | Gate |
|---|---|---|---|---|
| D1 | MacBook Air M3, 16 GB RAM | Current stable Chrome; Safari separately | Balanced, 1920×1080 | 60 FPS class |
| D2 | Windows desktop, RTX 3060, 16 GB RAM; record exact CPU | Current stable Chrome and Edge | High, 1920×1080 | 60 FPS class |
| D3 | Same measured desktop as D1 or D2 | Current stable Firefox | Balanced, 1920×1080 | 60 FPS class |
| L1 | Chromebook, 4 GB RAM; exact CPU/GPU selected at G0 | Stable ChromeOS browser | Low, 1280×720 | 30 FPS class |
| M1 | iPhone 16 Pro Max | Current supported iOS Safari | Balanced Mobile, 1280-pixel render width, viewport aspect | 60 FPS class |
| M2 | Midrange Android, 6 GB RAM; exact model selected at G0 | Stable Chrome | Low Mobile, 960-pixel render width, viewport aspect | 30 FPS class |
| T1 | Real tablet selected at G0 | Its supported browser | Low/Balanced appropriate to device | 30 FPS minimum plus touch usability |

The references are test objectives, not claims these devices will automatically meet the budgets. Select missing exact models before optimizing against them. Document replacements and do not quietly substitute a much faster device. Unavailable hardware produces an UNTESTED row and blocks the corresponding support claim.

Test stable browsers current at release and one previous major version where access permits. Record inaccessible old versions instead of claiming them. Opera receives a Chromium-family smoke test when available; passing Chrome is not itself proof of Opera compatibility. Optional 120 FPS and higher-resolution desktop modes are post-baseline enhancements, not mandatory claims.

## Frame-pacing gates

For the 60 FPS class: average delivered FPS ≥58, p95 frame interval ≤18.5 ms, p99 ≤33.4 ms, and no game-caused interval over 100 ms during a warmed active-driving run. For the 30 FPS class: average ≥29, p95 ≤36 ms and p99 ≤66.7 ms, with the same 100 ms freeze investigation threshold. A pass needs all measures, not just a flattering average.

Measure three 180-second runs after a 30-second warm-up, including Harbor's densest smoke corner, Ridge's widest vista and a chunk boundary. Report each run and the median; all runs must satisfy the mandatory bounds unless a documented external interruption makes a run invalid and it is repeated. Use a fixed benchmark quality and render resolution with dynamic scaling disabled. Separately test the automatic-quality mode.

On mobile, include a continuous 10-minute driving session and report both the first and last two minutes. On desktop include battery versus mains status and power mode. Screenshots, screen recording and open profilers can change performance; record whether they were active and capture clean benchmark runs separately.

## Metric definitions

Average FPS = rendered active frames / measured active seconds. Frame percentiles use actual inter-frame durations; record the percentile calculation method. “1% low FPS,” when included, means 1000 divided by the mean of the slowest 1% frame intervals, not simply 1000/p99. Include raw samples. Simulation steps, dropped accumulator time and long tasks are separate fields.

A CPU frame timer is not GPU time. Use supported GPU timing queries or external tooling only when available and trustworthy; record unsupported/disjoint samples. Browser heap reports are not total system memory or VRAM. Track JS/WASM, asset estimates and process observations separately without double counting shared allocations. `renderer.info` object counts are not byte-accurate GPU memory measurements. [S11, S16]

## Starting render allocation budgets

| Budget | Low | Balanced | High |
|---|---:|---:|---:|
| Total draw calls per frame, all passes | ≤150 | ≤250 | ≤400 |
| Main-view visible triangles | ≤120,000 | ≤300,000 | ≤650,000 |
| Player-car LOD triangles | ≤15,000 | ≤35,000 | ≤65,000 |
| Estimated resident GPU asset/target allocation | ≤160 MiB | ≤256 MiB | ≤384 MiB |
| Concurrent visible smoke particles | ≤100 | ≤300 | ≤600 |
| Shadow atlas starting budget | 1024² | 2048² | 2048²; larger only after evidence |

Main-view triangle count excludes shadow/reflection passes, which must also be reported. These are guardrails, not proof of speed. Overdraw, fill rate, shader complexity and uploads can dominate even under these counts. Tune effects downward when the actual frame gate fails.

For the Low compatibility build, target game JS/WASM working allocation below 192 MiB and avoid retaining decoded copies of every compressed texture. A 4 GB device has other memory users; passing a heap estimate does not establish device stability. Run a 30-minute desktop soak and 20 route/garage switch cycles; retained resources must plateau after warm-up, with no repeated unbounded growth or context-loss crashes.

## Load budget

Initial actual playable content: ≤8 MB transferred. Starting allocation: runtime code/physics ≤2 MB; first car mesh ≤0.6 MB; first world/collision ≤1.4 MB; textures/lighting ≤2.5 MB; audio ≤0.5 MB; remaining overhead ≤1 MB. Validate the sum from real network records, including transcoder/decoder files and loading dependencies.

First playable target on a defined clean-cache 20 Mbps / 100 ms RTT connection: p95 ≤10 seconds across ten boots. On 5 Mbps / 150 ms RTT: p95 ≤20 seconds. Record the server, compression behavior and test method. A menu, rolling loading animation or nonfunctional car is not first playable. Do not preload optional content before the portal's first genuine gameplay marker to game byte accounting.

Complete shipped game bundle target: ≤120 MB and ≤800 files. Measure packaged uncompressed asset bytes, upload archive bytes and actual transferred bytes separately. An archive compression ratio cannot be used as the network or resident-memory number. Individual portal ceilings remain separate constraints.

## Adaptive quality

Use explicit Low, Balanced, High and Auto settings. Auto begins conservatively and samples sustained frame behavior before adjusting. Reduce render scale/effects/particles/shadows before world readability; avoid oscillation by using hysteresis and a cooldown. Do not alter physics, event timers or scoring by graphics tier. Keep UI pixel-sharp and correctly scaled independently of the 3D canvas.

Quality fallbacks must preserve steering clarity, route markers, collision surfaces, car silhouette and readable smoke. Feature-detect optional extensions. Recover from context loss, shader failure and an asset-download error without losing already saved progression.

## Required performance deliverable

For each supported row, provide actual hardware/OS/browser versions, commit/build, preset, canvas and render dimensions, network/cache state, raw samples, percentile report, memory method, error logs and pass/fail verdict. A benchmark template with null values is not a benchmark result.

# 07 · Technical architecture

## Default decisions

Use TypeScript with strict checks, a lightweight static build pipeline such as Vite, Three.js for rendering, and Rapier for the chassis/collision layer. Use DOM/CSS for accessible menus/HUD rather than rerendering the entire 3D scene through a UI framework. Small libraries are acceptable after size, maintenance and license review. Pin working versions and record the actual tested Node/package/browser versions; this handoff deliberately does not guess future package versions.

The runtime is a static HTML5 game. No application server, runtime LLM, remote font service, analytics backend, login service or production asset CDN outside the portal's allowed resources is required. Browser modules, WASM and compressed-asset decoders must load from the bundled relative paths, except the target portal's authorized SDK loader.

## Repository shape to implement

```text
src/
  core/          bootstrap, app state, clocks, pause reasons, event bus
  physics/       Rapier integration, contact queries, surfaces
  vehicle/       drivetrain, wheel model, assists, telemetry
  events/        routes, checkpoints, scoring, medals
  progression/   rewards, unlock rules, career
  ghosts/        recordings, validation, playback, replay ring
  render/        renderer, materials, lighting, quality, resource lifetime
  vfx/           tire smoke, skid marks, bounded effects
  world/         chunks, route authoring data, collision/render instances
  input/         keyboard, pointer/touch, gamepad normalization
  camera/        chase, obstruction, replay and photo cameras
  audio/         gesture unlock, layered vehicles, buses, interruption
  ui/            HUD, garage, settings, results, legal
  platform/      standalone, poki, crazygames adapters
  save/          schema, migrations, stores, conflict protection
assets-source/   editable source assets and build-time source data
public/assets/   optimized runtime outputs and bundled decoders
contracts/       reviewed shared interfaces and schemas
content/         car, surface, route, event and quality records
/tests           unit, integration, browser and fixture suites
/tools           asset build, validation, benchmark, package/release tools
/evidence        commit-tagged captures, logs, traces and reports
/dist            separate platform output folders
```

Senior-owned composition modules live in `src/driving/`, `src/scene-pipeline/` and `src/experience/`. They compose specialist subsystems without creating parallel authoritative simulation loops. Private-only review UI/services live in `src/owner-tools/`.

Keep source assets outside the shipping bundle. No source maps, QA hooks, debug shortcuts or test fixtures in submission builds. Retain a separate profiling build so investigations remain reproducible.

## Runtime ownership

`GameApp` owns the renderer, simulation, state machine and subsystem lifetime. Only the simulation writes authoritative vehicle/event state. The renderer consumes read-only interpolated snapshots. UI translates actions and reads state; it does not advance timers. The platform adapter receives semantic transitions rather than being called directly by arbitrary UI components.

Use explicit typed events for session readiness, first player control, gameplay active/inactive, run finish, loading, ad state, context loss and save status. Do not create a global bag of mutable variables. Avoid transient allocation in the per-frame physics/render path.

## Clocks and pausing

Use separate wall-clock loading metrics, active fixed simulation time and render interpolation. Maintain a set of pause reasons: menu, manual, hidden, platform/ad, context loss and fatal recovery. Clearing one reason must not resume while another remains. Visibility restoration does not automatically override a manually paused game.

A platform lifecycle reducer emits deduplicated start/stop events only on actual activity transitions and using that platform's rules. The first-playable metric and first-player-input marker are different signals. Do not fire an early portal start event to make download metrics appear smaller.

## Rendering/physics boundary

World and car transforms use the shared coordinate convention. Vehicle snapshots include position/quaternion, linear/angular velocity, wheel state, RPM/gear and grounded/slip indicators. Interpolation does not mutate physics state. Camera/VFX/audio consume snapshots and validated events. Reset clears motion/camera/trail history together.

## Asset lifetime and loading

Maintain a manifest with logical asset ID, build hash, platform-relative URL, dependency group, compressed size, estimated resident allocation and owner. Boot loads only the real first playable content. Chunk loading is staged, cancelable, and error-aware. Never start a racing route unless required collision/render assets are ready. Preload safe adjacent chunks without hiding a loading pause at the first corner.

One resource manager tracks references for shared textures/materials/geometry. Scene disposal releases only owned resources. Repeated route switching must plateau in memory. Shader preparation should occur during legitimate loading boundaries where supported, not during the first smoke plume.

## Platform isolation

Compile-time target selection produces `owner-review`, `standalone`, `poki`, `crazygames-basic` and `crazygames-full`. The first is private and includes isolated review tools; the other four are production targets with those tools stripped. SDK names and callbacks remain inside adapters. The Basic configuration removes reward-ad affordances entirely. Standalone has a no-network adapter and a clearly marked QA ad simulator available only in the test build. Never load the simulator into a submission artifact.

Use a single save API with platform-specific authoritative storage. Do not require cross-origin isolation headers, SharedArrayBuffer, threaded WASM, OffscreenCanvas, fullscreen or pointer lock for the baseline. A worker optimization can be added only after actual target-environment validation and a maintained non-worker path.

## Build and test command contract

Implement and document: `npm ci`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run validate:content`, `npm run validate:assets`, `npm run build:standalone`, `npm run build:poki`, `npm run build:crazygames-basic`, `npm run build:crazygames-full`, `npm run benchmark`, and `npm run release:check`.

Also implement `npm run build:owner-review`, `npm run preview:owner`, `npm run play`, `npm run test:owner`, `npm run test:release-strip` and `npm run qa:owner-ready`. The play/preview commands serve an already-built review target; `play` opens the default browser without silent installation. See `OWNER_TESTING.md`.

These commands are requirements for the game repository, not commands already implemented by this documentation pack. CI must execute the noninteractive checks and attach artifacts on failure. Physical-device and human visual tests remain separately required.

## Change control

An engine swap, runtime backend, additional major dependency, physics timing change, public telemetry service, new monetization path or WebGPU-only material requires a reviewed decision record. Preserve the product contract and measured budgets; do not rewrite architecture solely because an agent prefers a familiar stack.

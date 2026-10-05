# Mobile notes: input and performance to UI/CSS

Written by the input/performance pass on 2026-10-01. The input side is done and tested. The items below need
src/ui, boot-shell, index.html or CSS, which belong to the UI agent.

## Touch control DOM contract (src/input/player-input.ts)

- The controls live in a root with `[data-control]` buttons: `left`, `right`, `throttle`, `brake`, `handbrake`.
  Fingers are tracked per pointer id with pointer capture. A finger can slide from one button onto another, for example ◀ to ▶.
  A lifted or cancelled finger, window blur, `pagehide`, a hidden page or any menu screen releases its input.
- Held buttons get the class `.is-pressed`. Style it however you like. Input only toggles the class.
- The root carries `data-steer-mode="buttons"` or `"drag"`.
  Optional: add a `[data-steer-zone]` element inside the root. It always acts as an analog drag-steer pad and also gets `.is-pressed`.
- Today bootstrap calls `createPlayerInput(canvas)` without a root, so input injects its own root and the old
  inline CSS string (`.lateral-touch-controls`). If you want to own the markup, render the root yourself and
  ask for bootstrap to pass it as the second argument (`createPlayerInput(canvas, yourRoot)`). Input then never hides it
  for you, so hide it yourself when `state.screen !== 'drive'` (input already ignores fingers outside driving).
- Elements need `touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none;
  -webkit-tap-highlight-color:transparent`. Input also prevents `touchstart` and `contextmenu` on them.

## Requests

1. **iOS URL bar height.** `html, body, #app { height:100% }` (boot-shell.css) can extend under the iOS Safari
   toolbar, which hides the bottom row of touch buttons. Input now publishes the visible height as
   `--lateral-viewport-height` on `<html>` and updates it on every resize, rotation and URL bar change. Please use
   `height: var(--lateral-viewport-height, 100dvh)` for `#app` (keep `100%` as a first declaration for old browsers).
   The canvas follows the root size automatically and never distorts.
2. **Landscape safe areas.** The touch root uses `inset:auto 12px …`. On notched iPhones in landscape, the left
   and right edges sit under the notch and rounded corners. Use `max(12px, env(safe-area-inset-left/right))`.
3. **Thumb sizes.** In landscape (`max-height:420px`) the buttons shrink to 50 px. Gas and ◀ ▶ should stay at 60 px or more,
   with at least 8 px gaps so a thumb sliding between ◀ and ▶ does not clip HB. Put handbrake next to gas
   (right thumb) or above it, not between the steering buttons and the pedals.
4. **Touch steering setting.** Add a Settings toggle "Touch steering: Buttons / Drag" wired to
   `input.setTouchSteerMode('buttons' | 'drag')` and read `input.steerMode`. The value persists in
   localStorage (`lateral.touchSteerMode`). Buttons is the default. In drag mode, the ◀ ▶ group is one analog pad:
   the finger's horizontal travel from its touchdown point steers, 64 px is full lock, and the pad goes through the same
   per-tick ramp. Please style the group as one pad when `data-steer-mode="drag"`. Only show the toggle when
   `matchMedia('(pointer: coarse)')` matches. Tilt steering was not added, because it needs an iOS permission prompt and per-device calibration.
5. **Touch prompts.** On touch devices, `input.activeDevice` is now `'touch'` from boot, so the tutorial and hint
   show touch copy before the first tap. Keyboard and gamepad still take over when they are used.
6. **Graphics default.** Phones now default to Low and tablets and desktops to Balanced. The profile default and the
   coordinator's initial selection follow this. The Settings quality picker needs no change, and the player's choice still
   persists and wins. Note: testers who already have a saved profile keep their saved `balanced`.
7. **Owner tools button** is still visible in the driving HUD on phones and takes thumb space next to Settings.

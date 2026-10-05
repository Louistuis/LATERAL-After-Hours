# 03 · Vehicle dynamics and drift scoring

## Objective

Create a controllable physical drift model, not a rotation animation. A car must accelerate, transfer load, break rear traction progressively, rotate, respond to countersteer and recover grip. The default experience is accessible simcade: believable causes with forgiving limits. The values below are starting implementation choices and tuning hypotheses, not validated automotive simulation data.

## Coordinates and timing

Use meters, kilograms, seconds, newtons and radians internally. World up is +Y; vehicle forward is local -Z; vehicle right is +X. Steering input +1 means steer right. Document conversion at every third-party boundary. Never mix degrees/radians or km/h and m/s inside the solver.

Use a **60 Hz fixed simulation step** on every quality tier, an accumulator, interpolated render transforms and a maximum of five catch-up steps per rendered frame. Clamp exceptional wall-clock deltas and record dropped simulation time; pause on document hiding instead of catching up minutes later. Rendering at 30, 60 or 120 Hz must not change tire parameters, event rewards or simulation time. Simulation steps, event clocks and scoring all use the same active simulation clock.

## Dynamics architecture

Rapier supplies the dynamic chassis rigid body, collision contacts and scene queries. It exposes forces/impulses and a raycast vehicle controller; these are building blocks, not a ready-made premium drifting game. Choose one reviewed vehicle-force path: our custom four-wheel model is preferred. Do not also run the built-in vehicle tire forces on the same chassis. [S14, S15]

Cast four suspension rays or shape casts from wheel mounts along suspension direction, excluding the chassis itself. For each grounded wheel derive hit point, normal, compression, contact-point velocity and road surface. Approximate the longitudinal and lateral contact axes on the hit plane. A wheel without ground contact generates no tire or suspension force.

A first suspension model is:

`F_s = clamp(k * compression + c * compressionRate, 0, F_max)`

Define compressionRate as positive when compression is increasing. The positive damping term then resists compression and reduces support during extension; verify the force directions with a drop test. Apply forces at their actual contact points so chassis roll/pitch and weight transfer arise from dynamics. Stabilizing assists must be bounded, exposed in tune data and documented; no invisible hard-lock of chassis yaw.

For a tire model, derive longitudinal slip from wheel angular speed versus contact speed and lateral slip angle from contact velocity. Smooth both near zero speed to avoid division spikes. Use a configurable saturating curve with a tunable peak and post-peak falloff, then apply a combined-force limit:

`(F_long / (mu_long * F_z))^2 + (F_lat / (mu_lat * F_z))^2 <= 1`

Clamp safely when normal load approaches zero. This friction ellipse is a simplified game-model constraint. Apply equal model conventions to all four wheels. Rear-wheel engine torque and handbrake must affect wheel slip and resulting forces, not directly add a canned drift angle. Include rolling drag, aerodynamic drag, braking and wheel rotational state.

## Drivetrain and assists

Use a small torque curve table, gear ratios, final drive, shift timing and a rev limiter. Automatic shifting is default; manual up/down shifting is an optional control setting. Prevent gear oscillation near shift thresholds. Reverse requires deliberate low-speed behavior and cannot unexpectedly engage during braking.

Implement rear differential behavior, speed-sensitive steering limits, configurable input smoothing and a gentle optional countersteer assist. The assist must not complete events unattended or override opposite deliberate input. Default assists should reduce snap-oversteer without removing the need to manage throttle.

Handbrake reduces rear-wheel rolling speed with a recoverable traction change. Grass/gravel/runoff surfaces reduce grip and pace using explicit surface parameters. Visual wetness is cosmetic in the base release; the dry/wet-looking lighting presets do not silently change physics or record comparability.

## Handling validation scenes

Provide a flat skidpad, acceleration/braking lane, constant-radius circle, slalom, paired hairpins, ramp/drop test, curb/seam test and collision wall. Log speed, yaw rate, steering, wheel contacts, compression, normal force and slip. Include tests for rest stability, reversing, maximum steering at speed, landing, reset and repeated contact loss. Tune all three cars on the same fixtures.

A pre-recorded input sequence run at different render rates must produce near-identical same-build trajectories and score. Cross-browser bitwise deterministic physics is not assumed. Replay visuals use snapshots so they do not depend on re-simulating identical floating-point results.

## Drift score proposal

Let `v_f` and `v_r` be forward/right contact-plane velocity; `beta = atan2(v_r, max(abs(v_f), epsilon))`. Score only when the car is substantially grounded, moving forward, inside the legal route corridor, above 5 m/s, at an absolute drift angle between 10° and 75°, and making new legal route progress. These thresholds are editable tune data.

A starting rate in design points per second is:

`rate = 100 * speedFactor * angleFactor * lineFactor * chainMultiplier`

Use a smooth speedFactor rising from 0 at 5 m/s to 1 at 25 m/s, a smooth angleFactor rising toward the intended 35–50° band and falling toward 75°, and a lineFactor between 1 and 1.5 near authored clipping zones. Integrate `rate * simulationDt`. Tune this after telemetry, not in the renderer.

Start chainMultiplier at 1; add one after each two seconds of valid linked drifting up to 5. Permit up to 0.7 seconds of grip during a direction transition without losing the chain. Bank after a clean 1.2-second exit. A major collision, sustained spin, reset or illegal shortcut discards unbanked points. Already banked points remain. Display the banked/unbanked distinction.

## Abuse resistance

Ordered checkpoint progress and a nearest-valid-segment search prevent scoring by oscillating across a line, reversing, rotating on the spot, skipping the course or wrapping a spline projection. Progress allowance must be bounded by traveled distance and plausible speed. Clip bonuses fire once per zone per valid pass, not once per frame. Hard impacts use impulse-derived velocity change, not an arbitrary raw impulse that penalizes heavy cars differently.

Test stationary donuts, wall riding, reverse drifts, airborne spinning, holding reset, repeated results entry, paused scoring, frame-rate manipulation and near-finish shortcutting. Free drive may show playful practice feedback, but event medal scores use the stricter rules. Do not claim client-side records are secure against a determined local attacker.

# 06 · Input, UI, camera and sound

## Interaction priorities

Control must feel direct, feedback must explain the car, and the HUD must not fight the road. Build a complete playable flow rather than polishing a landing page while the game remains graybox. There are no external account prompts or required purchases.

## Default controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Throttle / brake | W / S or Up / Down | Right / left trigger | Two large pedals |
| Steer | A / D or Left / Right | Left stick | Left/right buttons; optional steering pad |
| Handbrake | Space | Primary face button | Separate reachable button |
| Reset | R, with clear run consequence | Secondary face button, deliberate press | Reset in pause menu |
| Pause / resume | Escape | Menu button | Pause button |
| Camera | C | Shoulder button | Pause/settings selector |
| Shift, manual mode | E / Q | Two shoulder inputs after remap | Optional on-screen controls |

Avoid conflicting mappings: when manual shifting is enabled, select a distinct camera binding. Show the active map, support remapping for keyboard/gamepad and allow restoring defaults. Binding capture must not trap Escape or browser shortcuts. Suppress page scrolling only while the game has relevant focus; do not hijack unrelated page interaction.

Normalize device inputs before simulation, with per-device dead zones and input shaping. Clearing focus, opening a menu, disconnecting a gamepad, a pointer cancel or hiding the tab must clear held controls. Touch controls support simultaneous steer/throttle/handbrake without page zoom, selection or scroll conflicts. Mouse/touch operate every menu; keyboard focus is visible.

## Camera direction

Default to a stable third-person chase camera with mild speed-based distance/FOV adjustment, spring-damped position and bounded yaw lag. During a drift, show both vehicle orientation and travel direction without suddenly rotating 90 degrees around the car. Use camera collision/occlusion casts against designated geometry; recover smoothly when obstruction clears. Ground pitch/roll must not turn every curb strike into motion sickness.

Provide a closer chase view and hood/bumper view without pretending a full cockpit exists. Expose camera shake, FOV range, motion blur and reduced-motion controls. Verify at 30, 60 and high-refresh render rates; smoothing constants must be time-based rather than frame-based. On reset, explicitly reset camera history so it does not sweep through the map.

## HUD

Show speed in km/h by default, a readable gear indicator, drift angle/chain feedback, event timer/progress, banked versus current-chain score and a small route guide/minimap. The speed and angle must come from actual simulation telemetry. Display a temporary control hint appropriate to the current input device, then let it fade.

Keep vital information away from touch thumbs, platform overlays and device safe areas. At 640×360 the road and next turn still dominate. UI uses CSS-pixel sizing independently of the dynamic 3D render resolution. Maintain clear contrast and avoid communicating success/failure by color alone.

## Accessibility and recovery

Provide independent master/music/SFX levels, mute, reduced motion, optional camera shake, readable UI scale, ghost visibility and assist settings. Essential engine or warning cues must have visual equivalents. Menus must be keyboard navigable. Do not require rapid repeated button presses or color discrimination to complete the tutorial.

Landscape is the game design. Desktop adapts to the available iframe; mobile/tablet fills the allowed landscape viewport. Show a polite orientation message where the host does not already provide it. Do not require fullscreen or pointer lock to play.

## Sound design

Create layered engine audio based on RPM and load, with deliberate crossfades rather than pitching one short loop across the entire range. Include distinct car timbres, gear shifts, throttle lift, tire scrub, sustained skid, suspension/contact impacts, UI feedback and environment beds. Impact volume follows collision severity; tiny contacts must not sound like explosions.

Prioritize the player's tires/engine over music. Limit simultaneous voices, avoid audible loop seams and harsh clipping, and test on laptop speakers, headphones and a phone speaker. The game should remain intelligible with music disabled. No copyrighted commercial tracks or scraped vehicle recordings without documented rights.

Unlock/resume Web Audio through valid user interaction and verify interruption recovery on real iOS devices. The portal documentation specifically warns that iOS audio can require a new user gesture after interruption. [S05]

## Pause and advertisement sound behavior

Separate the user's mute state from temporary platform-ad mute and simulation pause reasons. Do not overwrite a saved mute preference while silencing an ad. On CrazyGames, pause interaction when requesting an ad but apply ad-specific audio mute on the SDK's actual ad-start signal; unfilled requests must not cause needless music interruptions. Restore only the audio states still appropriate after the terminal callback. [S07]

## Completion evidence

Capture the complete first session on keyboard, gamepad and real touch hardware; a garage/settings/results walkthrough; a sustained drift with sound; an obstruction/reset camera test; and a tab-hide/ad-pause/audio-resume sequence. No menu may be counted complete from a static mockup.

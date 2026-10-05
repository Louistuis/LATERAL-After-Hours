# 01 · Product and game design

## Identity

LATERAL: AFTER HOURS is a single-player automotive playground built around the pleasure of balancing a drift. The mood is coastal industrial realism at late afternoon and blue hour: sun-baked concrete, warm metal, pale road paint, dark sea, restrained sodium light. This is not a neon grid or a randomly generated endless highway.

The game supports two player intentions equally: a newcomer wants a satisfying slide in their first minute; a skilled player wants cleaner entries, transitions and clipping points. Skill expression comes from control, line and consistency, not grinding a faster car.

## First-session sequence

| Moment | What happens | Evidence target |
|---|---|---|
| Boot | Lightweight loading treatment, clear progress, no mandatory account or cinematic | Cold-start trace and first-input capture |
| First control | Starter car on the practice pad with one clear driving cue | At most one intentional start action after loading |
| First corner | Wide turn, forgiving recovery, visible drift-angle feedback | New player can discover steering/throttle without reading a manual |
| First success | Clean score pop, short tire feedback and a route invitation | A valid drift is achievable within 60 seconds of control in testing |
| First event | Short Harbor Drift Attack with transparent scoring | Complete the event and understand why the score rose or broke |
| First result | Medal progress, modest credit reward, retry and continue | Retry does not require navigating back through the garage |
| Return | Saved personal best, unlocked cosmetics and another route | No forced ad or purchase needed to continue |

The 60-second onboarding measure is our own test target, not a claimed playtest result. Small human playtests must assess comprehension; bots cannot certify fun.

## Core loop

Drive → initiate a slide → hold a controllable angle → link corners → earn/bank a clean chain → finish an event → compare to a personal best → tune or retry. Most authored events should last about 90–180 seconds. Free drive has no timer or mandatory objective. A player may open any unlocked route from the map or reach its start marker by driving.

## Modes

**Drift Attack:** A timed or route-bounded run with a drift score, clipping opportunities, clean-line bonuses and three medals. Chain banking and failure conditions must be visible. Stationary donuts and wall-grinding must not dominate route play.

**Time Trial:** Complete a route through ordered checkpoints. Clean lap/time feedback and a best-run ghost make the mode worthwhile even when the player does not drift. Invalid shortcuts, resets and wrong-way sections receive consistent treatment.

**Rival Ghost:** Chase an authored recorded run with tiered targets. These are explicitly labeled recorded rivals. Their transforms replay rather than pretending to be live opponents. They have no collision and no artificial catch-up force. The player can toggle the ghost off.

Each of the six routes gets all three event configurations, for 18 events total. Reusing a route for a different mode is intentional and does not count as another physical route.

## Content progression

The tutorial, starter car, practice pad and Harbor's first route are available immediately. Unlock Harbor's second route after one completed event; Ridge after three bronze medals; Coastline after six bronze medals. Unlock car two after three completed events and car three after six. Preserve an accessible test-drive path for all three cars without purchases or ads. These are starting balance values, subject to reviewed playtest changes.

Use one soft currency, Garage Credits, for cosmetic unlocks. No premium currency, energy, paid power, loot boxes, login streak pressure or forced online connection. Base event rewards should come from normal play; optional rewarded bonuses cannot be necessary to progress. Event completion transactions use unique run IDs so reopening results cannot duplicate rewards.

## Garage

Display a well-lit, rotatable real-time car. Offer paint, wheels, liveries, the three handling presets and understandable tuning sliders with reset-to-default. Show plain-language effects, not unexplained engineering sliders. Changing cosmetics never changes competitive performance. Tuning bounds keep every car drivable; no irrecoverable configurations.

## Menus and flows

Required screens: boot, first-play onboarding, HUD, pause, event/map selection, garage, settings, results, replay/photo mode and credits/legal. Every control has an implemented result. No “Coming soon” cards in a release build. Keep the player within two actions of a retry or free drive from results.

## Not part of version 1

Real-time opponents, open chat, custom user uploads, external accounts, global competitive anti-cheat, traffic simulation, police chases and destruction are excluded. A local-only score cannot be sold as a verified global leaderboard. Expansion requires new security, moderation, network and platform approval work.

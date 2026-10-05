# LATERAL security model

LATERAL on websim is a client-only game: it runs in a sandboxed iframe and has no server of its own. That limits what
any defence can promise. This page says what is protected, how, and what cannot be prevented.

## The short version

A determined cheater can change what **their own screen** shows. They cannot fake websim tips, cannot take anyone's
money, and cannot make other players see items they did not pay for.

## What is protected

### Real money (tips)

- Marks from tips are counted **only** from tip comments websim returns from its comments API (author id and
  `credits_spent` are set by websim, not by the game). 1 credit = 1 Mark, with the pack bonuses in `src/economy/tips.ts`.
- Posting a tip never credits anything. `redeem()` only opens websim's own tip window. Marks appear when a refresh reads
  the posted comment. The `comment:created` event is only a hint to refresh.
- Rows are deduped by comment id, must be authored by the signed-in user, must be `tip_comment` cards, must be on this
  project, and must carry a sane amount. A tip addressed to the tipper themself never counts, except the creator's own (the real tip rows on this project are addressed to the creator). `LATERAL_CREATOR_ID` is
  configured (`src/economy/boot.ts`), so a tip addressed to anyone else does not count either.
- A failed or truncated read (API error, page cap) is a lower bound. It never shrinks a total, never produces a negative
  balance, and marks the ledger as not settled. While it is not settled, purchases are refused and the economy retries
  with backoff.

### Purchases

- Serialized and idempotent: one purchase at a time, and a double click (or a second caller) for the same item shares one
  purchase and one result. Different items fired together cannot overspend.
- Item ids must be known catalog strings, prices must be non-negative safe integers (checked by `auditCatalog`), balances
  must be finite. The balance can never go below zero.
- Before spending, the store is read fresh. A second open tab or device is merged in first, so a stale tab cannot
  double-spend. If the store is unreachable, nothing is spent. If tips are still loading or incomplete, nothing is spent.
- Writes merge with the stored copy instead of replacing it, so a stale writer cannot drop a purchase.

### Missions

Missions (`src/economy/missions.ts`, content and rules in `mission-catalog.ts`) are an accrued, client computed source, so they are bounded instead of verified:

- Every mission has a fixed reward of 25 to 250 Marks, read from the catalog at claim time, never from the caller. The wallet clamps every grant to 250.
- A career mission pays once ever (a claim key stored in `WalletRecord.claims`, which is never evicted, unlike the 300 entry receipt list). A daily or weekly one pays once per UTC day or week (key includes the period). A mission only pays on an explicit claim.
- Events that count are checked first: valid run, 15 s to 1 h, current physics version, an assist level recorded, finite in-range score. Distance and speed come from frame samples; teleports, paused frames and impossible speeds (above 120 m/s) are dropped. Chain, drift time and crash recoveries only count when the run finishes validly, and are clamped to what the run could contain. Online results count only with another racer in the lobby; a win only once the race is decided with you first.
- The wallet ignores stored mission earnings above `missionCeiling(createdAt, now)`: every career mission once, plus the three best daily rewards for each UTC day, plus the two best weekly rewards for each UTC week since the wallet was created (server anchored when websim stores it). Remote verification adds the same ceiling to another player's budget, so a forged wallet row can show at most that much.
- Limits: a cheater can edit their own progress counters and claim every mission, but never more than the ceiling, and it only changes their own screen.

### Custom plate

`plate-custom` (9,990 Marks, the dearest item) lets the owner type their own plate text. The text is user generated, so it is validated at every trust boundary with the same code (`src/economy/plate.ts`): A-Z, 0-9, space and hyphen only (checked before uppercasing, so look-alike Unicode can not map onto ASCII), trimmed, single spaces, 2 to 8 characters, plus a word filter with leetspeak normalisation. It is checked when typed, when the wallet is saved and loaded, and when another player's presence arrives. On the wire it is an eighth segment of the loadout string, `x` plus hex, which can not contain the `.` or `~` separators; it fits the 200 character presence limit and passes `sanitizeText` unchanged. Other players see the text only when remote verification says the owner could afford `plate-custom` (tips, creator grant, daily and mission allowance), otherwise they see the default plate. The text is drawn on a canvas with `fillText`, never as HTML.

Limits: the word filter is a compact list, not a moderation service, and as a substring filter it has the usual false positives for the longest words. The mission allowance grows with wallet age (about 300 Marks a day), so a forged wallet row older than about a week can show a custom plate without tips; only the text of someone's own plate is at stake.

### Starter gift
Every wallet has a gift "from Louis" to open once (`src/economy/welcome.ts`). It holds 1,500 Marks and the free starter items (`starterGiftItems()`: the Challenger, Harbor Slate, Forged wheels, the stock horn). States per wallet: `unopened`, then `opened`; `economy.openGift()` opens it and `view().gift` says which. The Marks are paid when it is opened, not on load. It is an accrued source with the permanent claim `welcome:gift` (the claim is the opened flag; `trimClaims` keeps it), so a reload, a second tab or a copy of the wallet can not pay it twice, and a source ceiling of 1,500 for every wallet age means a forged `earned.welcome` above 1,500 is ignored, even if the claim is dropped. The same 1,500 is in every player's budget in `verifyOwned` (local) and in `createRemoteVerifier` (`welcomeAllowance`), so purchases made with the gift are never locked or hidden. The stock items cost nothing, so they stay usable before the gift is opened (the Challenger is drivable); until then the shop and garage only present them as "in your gift".

Opening the gift is a required step before the first drive (`src/ui/starter-gift.ts`, `ExperienceCoordinator.setPlayGate`): `drive()`, `startTutorial()` and `beginEvent()` (so Play, Solo, Online races and Drive) ask the gate first, which shows the reveal. Menus (Settings, Controls, Garage, Shop) stay reachable. It is a UI gate on a single-player client, not a security boundary: it only decides when the gift is shown. It can not soft-lock the game: `open()` marks the gift opened on this device at once and keeps retrying the Marks grant in the background if the wallet is slow or unreachable (`view().gift.pending`), the reveal also shows after 5 s if the wallet never answers, and Escape skips the reveal only after the box is open.

A forged wallet row can still show at most 1,500 Marks of items without tips (the allowance is part of every budget whether or not the gift was opened). The reveal is `src/ui/gift-reveal.ts`; all text goes through `textContent`.

### Ownership and tampering

- `owned` is an append-only purchase list. `spent` is **recomputed** from the catalog prices of the owned items. A stored
  `spent` number is never trusted, and merging two wallets recomputes it from the union.
- Owned items must be covered by a verified budget: Marks from tip comments plus the plausible gameplay allowance
  (25 Marks per UTC day since the wallet row was created, `GAMEPLAY_DAILY_CAP`). Items past the budget, oldest first, are
  **locked**: kept in the record (they unlock if the tips arrive) but not usable, not equipped, and not drivable.
- Stored `earned` gameplay Marks are capped to the same allowance, so editing localStorage or the wallet row to claim
  millions of Marks changes nothing. When websim reports the row's `created_at`, that server time is used, so the wallet
  cannot be backdated.
- Stored JSON is size-limited, lists and maps are bounded, unknown or free ids are dropped.

### Other players' cosmetics and cars

A client controls its own multiplayer presence and its own wallet row, so neither is believed. For every other player,
`src/economy/remote-verify.ts` looks up that user's tip total (from websim's comments) and their wallet row (websim sets
the row's `username` and `created_at`). Items are shown only if their verified budget could have paid for them, otherwise
the car renders stock and a car they did not buy renders as the starter. Until verification has run, premium looks are
never shown. Results are cached per user, and the tip index is fetched at most once per 45 seconds for the whole room.

### Cars

CAR-01 Challenger is the free starter. Every other car is a purchase. A locked car cannot be selected in the garage,
cannot be driven (`drive`, `startTutorial` and `beginEvent` all re-check and fall back to the starter), cannot be used in
online races, and is announced to other players as the starter. The standalone build has no sandbox profile.

### Multiplayer input (`src/net`)

Everything from other players and the room host is treated as hostile:

- car state packets are length-limited, NaN/Infinity rejected, positions and velocities clamped;
- names, paint strings, toasts and notices are capped and stripped of control and bidi characters; cosmetic ids are
  whitelisted against the catalog; avatars must be https;
- client ids are validated, the id websim attaches to a message wins over the one inside it, per-peer message rate is
  limited, at most 16 remote cars are ever loaded, and presence, lobbies, grids and race progress are bounded;
- clock samples that imply an offset of more than 10 minutes are ignored;
- message handling and remote car updates are wrapped, so a malformed message is dropped instead of reaching the render
  loop.

### Leaderboard

Entries must carry this build's physics version (`pv`), be integers, and fall inside sane ranges (lap 20 s to 1 h, drift
score 100 to 10 million). Names are sanitized, cars whitelisted, the scan is bounded. Entries without `pv` (older builds)
are ignored. Changing the physics version resets the board on purpose.

### Build

The standalone build has `__OWNER_REVIEW__` false. Owner tools, the loopback car, the proof hook, profile switching and
career reset are absent or throw. Checked on `LATERAL_OUT_ROOT=/root/lateral-build-sec npm run build:standalone`: no
`__LATERAL_PROOF__`, `netloopback`, owner tools markup or `mountOwnerTools` in the output.

## What a client-only game cannot prevent

- A cheater can edit their own page (devtools, a patched bundle) and make **their own screen** show anything: free items,
  a huge balance, any car. Nothing they do there reaches other players unverified, and nothing there spends websim credits.
- Mission progress is a client counter too. It can be forged up to the mission ceiling and no further (see Missions).
- Gameplay Marks are computed on the client. They are small and capped per UTC day, which limits the damage but does not
  make them unforgeable. A cheater can always reach the cap.
- A leaderboard time is a number a client submits. Plausibility checks reject impossible values, not skilled-looking
  fakes inside the ranges.
- A player can read other players' wallet rows (they are shared). They contain only what is already visible.
- Verification is bounded by websim: if the comments API is down or the project has more tip pages than the page cap, other
  players' premium items are hidden (fail closed) and the player's own purchases pause.
- Tips are counted while the comment exists. Deleting a tip comment removes its Marks after a reload (the session keeps
  them). The tip window copy asks players not to delete them.
- The creator grant (100,000 Marks, `src/economy/creator.ts`) is paid by a client-side websim user id check, so it only ever affects a cheater's own screen; other players verify the creator by the server-set websim username on the wallet row.
- Garage livery chips are cosmetic, local, and not part of the shop yet.

## Tests

`tests/economy/tips-security.test.ts`, `wallet-security.test.ts`, `missions.test.ts`, `plate.test.ts`, `tests/ui/plate-field.test.ts`, `tests/ui/missions-panel.test.ts`, `remote-verify.test.ts`, `catalog.test.ts`,
`tests/net/net-security.test.ts`, and the car gate test in `tests/experience/coordinator.test.ts`.

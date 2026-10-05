/**
 * Economy facade. Additive changes only; nothing here was renamed or narrowed.
 *
 * Items (cosmetics AND cars share one id space and one wallet):
 *   CATALOG       cosmetics only (what Loadouts hold), as before. Only Harbor Slate paint, Forged wheels and the stock
 *                 horn are free; everything else costs Marks. Prices end in 50 or 90 (190 to 2490).
 *   CAR_CATALOG   cars: CarItem { kind: 'car', slot: 'car', carId }. The starter (CAR-01 Challenger, STARTER.car) is free;
 *                 every other car is a premium buy above every cosmetic (Lancia Delta 2990, Cybertruck 4990, Formula 1 7990, the Agera halo car 8990).
 *   ITEMS         CATALOG + CAR_CATALOG as CatalogItem[]; narrow on item.kind ('cosmetic' | 'car').
 *   catalogEntry(id) any item, catalogItem(id) cosmetics only, itemKind(id), carItem(carId), shopCars(), STARTER.
 *
 * Economy facade (all present on createEconomy/bootEconomy results; optional in the Economy type):
 *   economy.itemState(id)      ItemState { status: 'stock' | 'owned' | 'buyable' | 'unaffordable' | 'locked' | 'unavailable',
 *                              usable, shortfall, reason, kind, slot, carId? }. Use this to draw shop cards.
 *   economy.items(kind?)       every shop-visible item as ItemState (hidden ones omitted).
 *   economy.carAllowed(carId)  may the player drive it now. Starter always true; others need a verified purchase.
 *   selectOwnedCar(economy, coordinator, carId)  the select/equip action for cars: refuses a locked car with a message,
 *                              else calls coordinator.selectCar (which enforces the same gate).
 *   economy.whenSettled(ms)    resolves true once the wallet is ready and ownership is verified.
 *   view().verified / .ledger / .locked / .budget / .purchasesOpen   verification state (all optional).
 *   view().owned and view().equipped never contain locked items. 'locked' = in the wallet record but not covered by
 *   verified Marks (a tampered or stale record); it unlocks by itself when the tips arrive.
 *   purchase() may now also fail with reason 'invalid' | 'unavailable'; 'not-ready' covers "tips still loading or
 *   incomplete" and 'store-failed' covers "wallet store unreachable". It is serialized and idempotent per item.
 * Missions: createMissionsSource() (boot adds it on every platform). source.views(), claim(key), claimable(), onComplete(fn), resets().
 *   Hidden from Get Marks (available() false); opened with ShopFeature.openMissions() / openMissions() in src/ui/missions-panel.ts.
 *   Additive hooks: EconomyGameEvents.onFrame/onOnlineRace, WalletGrantPort.progress/saveProgress/claimed/owned, GrantRequest.permanent,
 *   EarnSource.maxGrant/ceiling/walletChanged, WalletRecord.missions/claims. missionCeiling(createdAt, now) is the anti-cheat budget.
 * Starter gift: createWelcomeSource() (boot adds it on every platform). The gift holds WELCOME_MARKS (1500) and the free starter items
 *   (starterGiftItems()). view().gift = { state: 'unopened' | 'opened', marks, items, pending }; economy.openGift() opens it and pays the
 *   Marks once (permanent claim `welcome:gift` = opened; source ceiling 1500; the remote verifier budget includes it). The stock items stay
 *   usable before it is opened. Silent (not in Get Marks). UI: src/ui/gift-reveal.ts (the reveal), src/ui/starter-gift.ts (controller + gate).
 * Custom plate: catalog item 'plate-custom' (9990, slot plate). economy.setPlateText(text) validates (src/economy/plate.ts), needs a verified
 *   purchase and fits the plate; view().equipped.plateText is set only while that plate is fitted and usable. Loadout gained an optional
 *   plateText (not a slot); encodeLoadout/decodeLoadout carry it as an eighth '.x<hex>' segment. UI: src/ui/plate-field.ts in the showroom.
 * Earn sources: a source with silent: true (the creator grant, earnedBySource.creator) is counted but never listed in Get Marks.
 * Car gate: src/ui/shop-feature.ts installs coordinator.setCarGate(...) so a locked car can not be selected or driven.
 * Remote players: createRemoteVerifier() decides which of another player's cosmetics and car are shown (SECURITY.md).
 */
export * from './types';
export { CAR_CATALOG, CATALOG, ITEMS, RARITY, SLOTS, STARTER, auditCatalog, carItem, catalogEntry, catalogItem, decodeLoadout, encodeLoadout, isCarItem, itemKind, itemsForSlot, isStock, priceOf, sanitizeLoadout, shopCars } from './catalog';
export { createEconomy, type EconomyOptions } from './economy';
export { selectOwnedCar, type CarSelectResult, type CarSelector } from './car-select';
export { bootEconomy, platformFor, type BootedEconomy, type EconomyBootOptions, type EconomyPlatform, type PortalAdapters } from './boot';
export { createDataStoreWalletStore, createDeferredStore, createLayeredStore, createLocalWalletStore } from './stores';
export { createGameplaySource, GAMEPLAY_DAILY_CAP, marksForRun } from './gameplay';
export { MARKS_PER_CREDIT, TIP_PACKS, marksForTipCredits } from './tips';
export { CREATOR_GRANT_MARKS, LATERAL_CREATOR_USERNAME, createCreatorSource } from './creator';
export { createWelcomeSource, starterGiftItems, WELCOME_MARKS, WELCOME_CLAIM, type WelcomeSource } from './welcome';
export { createRemoteVerifier, type RemoteVerifier } from './remote-verify';
export { createMissionsSource, MissionTracker, onlineOutcome, type MissionsSource, type ClaimResult } from './missions';
export { missionCeiling, missionViews, CAREER, DAILY_POOL, WEEKLY_POOL, CAREER_TOTAL, DAILY_MAX, WEEKLY_MAX, type MissionView, type MissionDef } from './mission-catalog';
export { CUSTOM_PLATE_ID, DEFAULT_PLATE_TEXT, PLATE_MAX, PLATE_MIN, cleanPlateText, decodePlateText, encodePlateText, isBlockedPlate, validatePlateText, type PlateCheck, type PlateReason } from './plate';

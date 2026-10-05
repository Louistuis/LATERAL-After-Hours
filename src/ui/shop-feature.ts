/**
 * Wires the economy into the running game with as few touch points as possible:
 * boots the platform's economy, folds the loadout into the scene's cosmetics, pays gameplay Marks on
 * finished runs, plays the equipped horn and mounts the shop. The shell only calls mountShopFeature.
 */
import type { RunResult } from '../../contracts/runtime-contracts';
import type { GameRuntime } from '../core/game-runtime';
import type { ExperienceCoordinator } from '../experience/coordinator';
import { createEconomyAudio, type EconomyCueSink } from '../economy/audio';
import { bootEconomy, type EconomyPlatform } from '../economy/boot';
import { catalogItem, STARTER } from '../economy/catalog';
import { setTyreSmokeColor } from '../economy/fx-state';
import { installLoadoutOverlay, setLoadoutProvider, setLocalHornPlayer, type CosmeticsLike } from '../economy/loadout-bridge';
import type { Economy, FrameSample, Loadout, OnlineRaceSample } from '../economy/types';
import type { CarId, LightingPreset, RouteId } from '../../contracts/runtime-contracts';
import { focusablesIn, mountShowroom, spatialPick, type Showroom, type ShowroomMenuAction } from '../showroom/ui';
import { onlineOutcome, type MissionsSource, type OnlineViewLike } from '../economy/missions';
import { mountMissionToasts, openMissions, type MissionsPanel } from './missions-panel';
import { SELFHOST } from '../core/target';
import { selfhostServices } from '../selfhost/boot';
import { mountGiftsUi, type GiftsUi } from '../selfhost/gifts-ui';
import type { ActionResult } from '../selfhost/wallet-store';
import { mountStarterGift, type StarterGift } from './starter-gift';
import { TUNING_PRESETS } from '../vehicle/configs';
import type { TunePresetId } from '../vehicle/types';

export interface ShopFeature {
  readonly economy: Economy;
  readonly platform: EconomyPlatform;
  /** The full-screen showroom (src/showroom), where every purchase happens. */
  readonly panel: Showroom | null;
  available(): boolean;
  /** Shop mode (same as openShop()). */
  open(): void;
  /** Entry point: the showroom in Shop mode, optionally on one item. */
  openShop(itemId?: string): void;
  /** Entry point: the showroom in Garage mode (owned cars, fitted parts, livery, tune, track). */
  openGarage(): void;
  /** Missions earn source, or null when the build has none. */
  readonly missions: MissionsSource | null;
  /** Opens the Missions screen (pauses into the menu first when driving). */
  openMissions(): void;
  balanceText(): string;
  /** Self-hosted build: gifts waiting in the inbox (the menu badge), opening one, and redeeming a code. */
  inboxCount(): number;
  openInbox(): void;
  redeemCode(code: string): Promise<ActionResult>;
  /** Marks waiting in the unopened starter gift, or null once it is opened (the menu shows a gift button and a balance hint). */
  giftHint(): number | null;
  /** Shows the starter gift reveal (no-op when it is already open). */
  openGift(): void;
  /**
   * Gamepad menu navigation for the layers this feature owns (the starter gift reveal, then the showroom).
   * True when one of them took it; false means the menu behind should handle it.
   */
  menuAction(action: ShowroomMenuAction): boolean;
  dispose(): void;
}

export function mountShopFeature(uiShell: HTMLElement | null, runtime: GameRuntime, coordinator: ExperienceCoordinator, hooks: {
  focusDrive(): void;
  /** The online feature's view stream (missions read your race results from it). Optional. */
  online?: { subscribe(listener: (view: OnlineViewLike | null) => void): () => void; status?(): 'off' | 'connecting' | 'ready' };
  /** The game's audio facade: purchase, Marks, tick and deny cues play through it when it is unlocked. */
  cues?: EconomyCueSink;
}): ShopFeature {
  const finished = new Set<(result: RunResult) => void>();
  const frames = new Set<(sample: FrameSample) => void>();
  const races = new Set<(sample: OnlineRaceSample) => void>();
  let panel: Showroom | null = null;
  let starterGift: StarterGift | null = null;
  let giftsUi: GiftsUi | null = null;
  let lastRunId = coordinator.state().runtime.result?.runId ?? null;
  const { economy, platform } = bootEconomy({
    target: __BUILD__.target,
    game: {
      onRunFinished: listener => { finished.add(listener); return () => { finished.delete(listener); }; },
      onFrame: listener => { frames.add(listener); return () => { frames.delete(listener); }; },
      onOnlineRace: listener => { races.add(listener); return () => { races.delete(listener); }; },
    },
    // Missions are only offered when they can be completed with what the build has right now.
    missionContext: () => ({
      routes: runtime.routes().map(route => route.id),
      online: (hooks.online?.status?.() ?? 'off') !== 'off',
      rival: coordinator.state().rivalAvailable === true,
      cars: true,
    }),
  });
  const missions = (economy.sources().find(source => source.id === 'missions') as MissionsSource | undefined) ?? null;

  /* ---------------------------------------------------------------- mission events */
  // One light sample per rendered frame, only while a mission source is listening.
  const offFrames = runtime.subscribe(view => {
    if (!frames.size) return;
    const car = view.frame.current, v = car.linearVelocityMS;
    const sample: FrameSample = {
      tick: car.simulationTick, paused: view.paused || view.presentation !== 'drive', x: car.position.x, y: car.position.y, z: car.position.z,
      speedMS: Math.hypot(v.x, v.y, v.z), runId: view.run?.runId ?? null, active: view.run?.state === 'ACTIVE',
      unbanked: view.frame.score.unbanked, validDrift: view.frame.score.validDrift, recoveries: view.recovery?.count ?? 0, hasMedalTargets: Boolean(view.medalTargets),
    };
    for (const listener of frames) { try { listener(sample); } catch (error) { console.warn('LATERAL mission frame failed', error); } }
  });
  const offOnline = hooks.online?.subscribe(view => {
    const outcome = onlineOutcome(view);
    if (outcome) for (const listener of races) { try { listener(outcome); } catch (error) { console.warn('LATERAL mission race failed', error); } }
  });
  const audio = createEconomyAudio(() => {
    const settings = coordinator.state().settings;
    return settings.muted ? 0 : settings.masterVolume * settings.sfxVolume;
  }, hooks.cues);
  // Marks earned while the showroom is closed (race rewards, missions, tips) get a coin cue; the open showroom plays its own.
  let creditSeq = economy.view().lastCredit?.seq ?? null;
  const offCreditCue = economy.subscribe(() => {
    const credit = economy.view().lastCredit;
    if (!credit || credit.seq === creditSeq) return;
    creditSeq = credit.seq;
    if (!panel?.isOpen && credit.amount > 0) hooks.cues?.playCue('marks');
  });

  /* ---------------------------------------------------------------- loadout on the car */
  const effective = (base: CosmeticsLike): Loadout => {
    const equipped = economy.view().equipped;
    const out: Loadout = { ...equipped };
    // Garage chips are not a free side door: a paint or wheel style that is not stock or owned renders as the stock one.
    if (!out.paint) out.paint = base.paint && economy.owns(base.paint) ? base.paint : STARTER.loadout.paint;
    out.wheelStyle = base.wheelStyle && economy.owns(base.wheelStyle) ? base.wheelStyle : STARTER.loadout.wheelStyle;
    return out;
  };
  setLoadoutProvider(effective);
  const overlay = installLoadoutOverlay(runtime.scene, coordinator.state().cosmetics ?? {});
  let applied = '';
  const sync = (): void => {
    const loadout = effective(coordinator.state().cosmetics ?? {});
    const key = JSON.stringify(loadout);
    if (key === applied) return;
    applied = key;
    overlay.reapply();
    setTyreSmokeColor(catalogItem(economy.view().equipped.smoke)?.swatch[0] ?? null);
  };
  const offEconomy = economy.subscribe(sync);
  sync();

  /* ---------------------------------------------------------------- car ownership */
  // A locked car can not be selected or driven (and so not raced online); the starter car is always allowed.
  coordinator.setCarGate({
    allowed: car => economy.carAllowed?.(car) ?? true,
    settled: () => economy.whenSettled?.(4000) ?? Promise.resolve(true),
  });
  let carKey = '';
  const offCars = economy.subscribe(() => {
    const key = (economy.items?.('car') ?? []).map(item => (item.usable ? 1 : 0)).join('');
    if (key === carKey) return;
    carKey = key;
    void coordinator.reconcileCar();
  });

  /* ---------------------------------------------------------------- game events */
  let lastStockPaint = coordinator.state().cosmetics?.paint;
  const offCoordinator = coordinator.subscribe(state => {
    // Every route into the garage screen (menu, results, pause) lands in the showroom's Garage mode.
    if (state.screen === 'garage' && panel && !panel.isOpen) queueMicrotask(() => { if (coordinator.state().screen === 'garage' && panel && !panel.isOpen) panel.open({ mode: 'garage' }); });
    const runId = state.runtime.result?.runId ?? null;
    if (runId && runId !== lastRunId) {
      lastRunId = runId;
      const result = state.runtime.result!;
      for (const listener of finished) { try { listener(result); } catch (error) { console.warn('LATERAL earn source failed', error); } }
    }
    const stockPaint = state.cosmetics?.paint;
    if (stockPaint !== lastStockPaint) {
      lastStockPaint = stockPaint;
      // A workshop paint chip picked in the garage replaces a premium finish (profile restores do not).
      if (state.screen === 'garage' && !panel?.isOpen && economy.view().equipped.paint) void economy.equip('paint', null);
      else sync();
    }
  });

  /* ---------------------------------------------------------------- missions screen and toasts */
  let missionsPanel: MissionsPanel | null = null;
  const offToasts = uiShell && missions ? mountMissionToasts(uiShell, missions) : null;
  const leaveDriveForMissions = (): void => { if (coordinator.state().screen === 'drive') coordinator.open('pause'); };
  function showMissions(): void {
    if (!uiShell || !missions) return;
    leaveDriveForMissions();
    if (missionsPanel) return;
    missionsPanel = openMissions(uiShell, missions, { onClose: () => { missionsPanel = null; } });
  }

  /* ---------------------------------------------------------------- horn */
  const honk = (): boolean => { audio.horn(economy.view().equipped.horn); return true; };
  setLocalHornPlayer(honk);
  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyH' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (coordinator.state().screen !== 'drive') return;
    // The multiplayer horn handles H while online (and plays this horn through playLocalHorn).
    queueMicrotask(() => { if (!event.defaultPrevented) honk(); });
  };
  window.addEventListener('keydown', onKey);
  let hornButton: HTMLButtonElement | null = null;
  let hornTimer = 0;
  const onHornPointer = (event: PointerEvent): void => { event.preventDefault(); event.stopPropagation(); honk(); };
  if (uiShell) {
    hornButton = document.createElement('button');
    hornButton.className = 'lp-shop-horn'; hornButton.type = 'button'; hornButton.textContent = 'Horn'; hornButton.hidden = true;
    hornButton.setAttribute('aria-label', 'Horn');
    hornButton.addEventListener('pointerdown', onHornPointer);
    uiShell.append(hornButton);
    hornTimer = window.setInterval(() => {
      const netHorn = uiShell.querySelector<HTMLElement>('.lp-net-horn');
      hornButton!.hidden = coordinator.state().screen !== 'drive' || Boolean(netHorn && !netHorn.hidden);
    }, 300);
  }

  /* ---------------------------------------------------------------- shop */
  panel = uiShell ? mountShowroom(uiShell, runtime.scene, economy, audio, {
    equipped: () => effective(coordinator.state().cosmetics ?? {}),
    livery: () => coordinator.state().cosmetics?.livery,
    setStock: (slot, id) => coordinator.setCosmetics({ ...coordinator.state().cosmetics, [slot]: id }),
    currentCar: () => coordinator.state().selection.car,
    selectCar: carId => coordinator.selectCar(carId as CarId),
    drive: () => { void coordinator.drive().then(() => hooks.focusDrive()).catch(() => {}); },
    screen: () => coordinator.state().screen,
    volume: () => { const settings = coordinator.state().settings; return settings.muted ? 0 : settings.masterVolume * settings.sfxVolume; },
    quality: () => runtime.quality().effective,
    garage: {
      liveries: () => runtime.scene.cosmeticsCatalog?.liveries ?? [],
      tunes: () => (['Balanced', 'Grip', 'Drift'] as const).filter(id => id in TUNING_PRESETS),
      routes: () => runtime.routes().map(route => ({ id: route.id, name: (route as { name?: string }).name ?? route.id })),
      lightings: () => [{ id: 'golden-hour', name: 'Golden hour' }, { id: 'blue-hour', name: 'Blue hour' }],
      current: slot => {
        const state = coordinator.state();
        if (slot === 'livery') return state.cosmetics?.livery ?? 'stock';
        if (slot === 'tune') return state.selection.customTune ? undefined : state.selection.tune;
        if (slot === 'route') return state.selection.route;
        return state.selection.lighting;
      },
      set: async (slot, id) => {
        const state = coordinator.state();
        if (slot === 'livery') await coordinator.setCosmetics({ ...state.cosmetics, livery: id });
        else if (slot === 'tune') await coordinator.selectTune(id as TunePresetId);
        else if (slot === 'route') await coordinator.selectRoute(id as RouteId);
        else await coordinator.setPresentation(id as LightingPreset, state.selection.quality);
      },
    },
    openGift: () => starterGift?.open(),
    openMissions: SELFHOST ? showMissions : undefined,
    // Garage screen replaced by the showroom: closing returns to the menu instead of the old panel.
    onClose: () => { if (coordinator.state().screen === 'garage') coordinator.open('pause'); },
  }) : null;

  // From driving there is no menu behind the page, so pause into the menu first.
  const leaveDrive = (): void => { if (coordinator.state().screen === 'drive') coordinator.open('pause'); };
  function openShop(itemId?: string): void { leaveDrive(); panel?.open({ mode: 'shop', item: itemId }); }
  function openGarage(): void { leaveDrive(); panel?.open({ mode: 'garage' }); }

  // The starter gift (1,500 Marks and the free starter items, from Louis): a required reveal before the first drive.
  // The coordinator asks the gate before it starts any drive; menus stay reachable. See src/ui/starter-gift.ts.
  starterGift = uiShell ? mountStarterGift({
    economy, shell: uiShell,
    drive: () => { void coordinator.drive().then(() => hooks.focusDrive()).catch(() => {}); },
    openShop: () => openShop(),
    screen: () => coordinator.state().screen,
    menuReady: () => !coordinator.state().busy && (!SELFHOST || selfhostServices().isDecided()),
    subscribeScreen: listener => coordinator.subscribe(() => listener()),
    // The menus redraw from the coordinator state: re-installing the gate emits it, so the gift chip and balance hint update.
    onChange: () => { if (starterGift) coordinator.setPlayGate(gate); },
  }) : null;
  // Self-hosted: gifts from the server (inbox, codes, `?gift=` links) play the same reveal as the starter gift.
  giftsUi = SELFHOST && uiShell ? mountGiftsUi({
    shell: uiShell, services: selfhostServices(), economy,
    openShop: () => openShop(),
    drive: () => { void coordinator.drive().then(() => hooks.focusDrive()).catch(() => {}); },
    screen: () => coordinator.state().screen,
    subscribeScreen: listener => coordinator.subscribe(() => listener()),
  }) : null;
  // The menu redraws from the coordinator state: a gift arriving or being opened re-installs the gate to emit it.
  const offInbox = SELFHOST ? selfhostServices().gifts.subscribe(() => { if (starterGift) coordinator.setPlayGate(gate); }) : null;
  const gate = { allowed: () => starterGift?.allowed() ?? true, require: () => starterGift?.require() ?? Promise.resolve(true) };
  coordinator.setPlayGate(starterGift ? gate : null);

  return {
    economy, platform, panel,
    available: () => panel !== null,
    open: () => openShop(),
    openShop,
    openGarage,
    missions,
    openMissions: showMissions,
    balanceText: () => panel?.balanceText() ?? '',
    inboxCount: () => giftsUi?.count() ?? 0,
    openInbox: () => giftsUi?.openInbox(),
    redeemCode: code => giftsUi?.redeemCode(code) ?? Promise.resolve({ ok: false, code: 'unavailable', message: 'Gifts are not ready yet.', retry: true }),
    giftHint: () => starterGift?.hint() ?? null,
    openGift: () => starterGift?.open(),
    menuAction(action) {
      // The gift reveal is a required step on top of everything: the gamepad drives it like its own keyboard handler.
      const gift = uiShell?.querySelector<HTMLElement>('.lp-gf');
      if (gift) {
        const items = focusablesIn(gift);
        const current = items.find(item => item === document.activeElement) ?? null;
        if (action === 'back') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        else if (action === 'accept') { if (current) current.click(); else (items.find(item => item.classList.contains('go')) ?? items[0])?.focus(); }
        else { const next = current ? spatialPick(items, current, action) : items[0]; next?.focus(); }
        return true;
      }
      return panel?.menuAction(action) ?? false;
    },
    dispose() {
      offEconomy(); offCreditCue(); offCars(); offCoordinator(); coordinator.setCarGate(null);
      offFrames(); offOnline?.(); offToasts?.(); starterGift?.dispose(); giftsUi?.dispose(); offInbox?.(); coordinator.setPlayGate(null); missionsPanel?.close();
      window.removeEventListener('keydown', onKey);
      clearInterval(hornTimer);
      hornButton?.removeEventListener('pointerdown', onHornPointer); hornButton?.remove();
      panel?.dispose();
      overlay.dispose();
      setLoadoutProvider(null); setLocalHornPlayer(null); setTyreSmokeColor(null);
      economy.dispose(); audio.dispose();
    },
  };
}

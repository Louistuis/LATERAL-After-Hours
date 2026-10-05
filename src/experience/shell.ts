import type { PlatformAdapter } from '../../contracts/runtime-contracts';
import type { GameRuntime } from '../core/game-runtime';
import { attachMenuSounds, createPlayerAudio } from '../audio';
import { createPlayerCamera } from '../camera';
import { DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS, type GamepadBindings, type KeyboardBindings, type PlayerInput } from '../input';
import { createPlayerUI } from '../ui';
import { mountOnlinePanel, type OnlinePanel } from '../ui/online-panel';
import { mountShopFeature, type ShopFeature } from '../ui/shop-feature';
import { mountFeatureHub, type FeatureHub } from '../ui/feature-hub';
import { createOnlineFeature } from '../net';
import { MAX_NAME, safeAvatarUrl, sanitizeText } from '../net/sanitize';
import { websimHost, withTimeout } from '../economy/websim-host';
import { SELFHOST } from '../core/target';
import { selfhostServices } from '../selfhost/boot';
import { createAccountBlock, mountAccountGate } from '../selfhost/account-ui';
import { ExperienceCoordinator, type ExperienceRewards, type ProfileRepository } from './coordinator';
import type { BugReportDetails } from '../save/profile-repository';
import type { RecoveryInspection } from '../save/profile-repository';
import type { OwnerProfile } from '../../contracts/owner-review-contracts';

export interface ExperienceShellPorts {
  readonly input: PlayerInput;
  readonly profiles: ProfileRepository;
  readonly platform: PlatformAdapter;
  readonly rewards: ExperienceRewards;
  readonly ownerTools?: ((coordinator: ExperienceCoordinator) => {
    readonly onExportSave?: () => Promise<Blob>;
    readonly onExportBugReport?: (details: BugReportDetails) => Promise<Blob>;
    readonly onResetCareer?: () => Promise<void>;
    readonly inspectProfileRecovery?: (profile: OwnerProfile) => Promise<RecoveryInspection>;
    readonly onExportRawBackup?: (profile: OwnerProfile) => Promise<Blob>;
    readonly onPlayProfileForSession?: (profile: OwnerProfile) => Promise<void>;
  });
}
export interface ExperienceShell {
  readonly coordinator: ExperienceCoordinator;
  dispose(): void;
}

/** Mounts the player-facing composition over A0's scene/runtime canvas. */
export async function createExperienceShell(host: HTMLElement, runtime: GameRuntime, ports: ExperienceShellPorts): Promise<ExperienceShell> {
  const audio = createPlayerAudio();
  const detachAudioUnlock = typeof document === 'undefined' ? () => {} : audio.armGestureUnlock(document);
  const camera = createPlayerCamera(runtime.scene);
  const coordinator = new ExperienceCoordinator(runtime, { profiles: ports.profiles, platform: ports.platform, rewards: ports.rewards, audio });
  let onlinePanel: OnlinePanel | null = null;
  // Websim player name and avatar for the title screen (null elsewhere, and the chip stays hidden).
  let profile: { name: string; avatarUrl: string } | null = null;
  const websim = SELFHOST || typeof window === "undefined" ? null : websimHost();
  // Self-hosted: the driver name of the signed in account stands in for the platform name.
  const selfhost = SELFHOST ? selfhostServices() : null;
  const profileNow = (): { name: string; avatarUrl: string } | null => {
    if (!selfhost) return profile;
    const account = selfhost.account.current();
    return account ? { name: account.name, avatarUrl: '' } : null;
  };
  if (websim) void withTimeout(websim.getCurrentUser(), 6000).then(user => { const name = sanitizeText(user?.username, MAX_NAME); if (name) profile = { name, avatarUrl: safeAvatarUrl(user?.avatar_url) }; }).catch(() => {});
  let shop: ShopFeature | null = null;
  // Daily challenge, ghosts, photo mode, replay, achievements (src/ui/feature-hub.ts). Mounted after the shop.
  let features: FeatureHub | null = null;
  // Websim only: resolves to an unavailable feature everywhere else, so the menu never shows Online.
  const online = createOnlineFeature(runtime, coordinator, {
    beforeRace: () => onlinePanel?.close(),
    focusDrive: () => ports.input.focusDrivingCanvas(),
  });
  const ui = createPlayerUI(host, coordinator, {
    online: { available: () => online.available(), count: () => online.playersOnline(), open: () => { if (!coordinator.playAllowed()) { shop?.openGift(); return; } onlinePanel?.open(); }, status: () => online.status(), isOpen: () => onlinePanel?.isOpen ?? false, close: () => onlinePanel?.close() },
    garage: { open: () => { onlinePanel?.close(); if (shop) shop.openGarage(); else coordinator.open('garage'); } },
    profile: profileNow,
    quality: () => runtime.quality().effective,
    remap: { pending: () => ports.input.pendingRemapAction, cancel: () => ports.input.cancelRemap(), subscribe: listener => ports.input.onRemap(listener) },
    onMenuMode: mode => camera.setShowcaseStyle(mode === 'title' ? 'title' : 'pause'),
    shop: { available: () => shop?.available() ?? false, open: () => { onlinePanel?.close(); shop?.openShop(); }, balance: () => shop?.balanceText() ?? '', gift: () => shop?.giftHint() ?? null, openGift: () => shop?.openGift(), inbox: () => shop?.inboxCount() ?? 0, openInbox: () => shop?.openInbox() },
    missions: { available: () => shop?.missions != null, open: () => { onlinePanel?.close(); shop?.openMissions(); } },
    features: { menu: () => features?.menu() ?? null, open: action => { onlinePanel?.close(); features?.open(action); } },
    title: 'LATERAL · AFTER HOURS', routes: runtime.routes(),
    onCameraCycle: () => camera.cycleView(),
    onDriveFocus: () => ports.input.focusDrivingCanvas(),
    activeDevice: () => ports.input.activeDevice,
    touchSteerMode: () => ports.input.steerMode,
    onTouchSteerMode: mode => ports.input.setTouchSteerMode(mode),
    keyboardBindings: () => JSON.parse(ports.input.getBindings().keyboard) as KeyboardBindings,
    gamepadBindings: () => JSON.parse(ports.input.getBindings().gamepad) as GamepadBindings,
    gamepadMapping: () => Array.from(navigator.getGamepads?.() ?? []).find(pad => pad?.connected)?.mapping ?? null,
    onBeginKeyboardRemap: action => ports.input.beginRemap(action),
    onBeginGamepadRemap: action => ports.input.beginGamepadRemap(action),
    onRestoreDefaultBindings: () => {
      void coordinator.setSettings({ keyboardBindings: '', gamepadBindings: '' }).catch(error => ui.announce(message(error)));
    },
  });
  const uiShell = host.querySelector<HTMLElement>('.lp-shell');
  if (uiShell && typeof window !== 'undefined') onlinePanel = mountOnlinePanel(uiShell, online, {
    currentCar: () => coordinator.state().selection.car,
    screen: () => coordinator.state().screen,
    onFreeRoam: () => {
      coordinator.freeDrive();
      void coordinator.drive().then(() => ports.input.focusDrivingCanvas()).catch(error => ui.announce(message(error)));
    },
    onClosed: () => {},
    routes: () => runtime.routes().map(route => ({ id: route.id, name: route.name ?? route.id })),
    inEvent: () => { const view = coordinator.state().runtime; return view.mode !== 'free-drive' && view.run !== null && view.result === null; },
    badges: id => features?.badges(id) ?? [],
  });
  // Cosmetic shop and Marks wallet (src/economy). Mounted before initialize() so the restored profile paint carries the loadout.
  shop = mountShopFeature(uiShell, runtime, coordinator, { focusDrive: () => ports.input.focusDrivingCanvas(), online, cues: audio });
  if (uiShell && typeof window !== 'undefined') features = mountFeatureHub(uiShell, {
    runtime, coordinator, online, shop: () => shop, profile: profileNow,
    accountBlock: selfhost && uiShell ? () => createAccountBlock({ shell: uiShell, services: selfhost, reload: () => { window.location.reload(); }, redeem: code => shop?.redeemCode(code) ?? Promise.resolve({ ok: false, code: 'unavailable', message: 'Gifts are not ready yet.', retry: true }) }) : undefined,
    resetCamera: () => camera.reset(), focusDrive: () => ports.input.focusDrivingCanvas(),
  });
  // Self-hosted first run: the driver name step (or the recovery code that was not saved yet) sits on top of the menu.
  const accountGate = selfhost && uiShell ? mountAccountGate(uiShell, selfhost, { pendingGift: () => Boolean(selfhost.gifts.pendingCode()), onReady: () => {} }) : null;
  const detachOnlineClose = coordinator.subscribe(state => { if (state.screen === 'drive' && onlinePanel?.isOpen) onlinePanel.close(); });
  // Photo mode and the replay director take the camera while they are open; otherwise the player camera runs.
  runtime.setCameraController((frame, dt, presentation, paused) => { if (!features?.cameraOverride(frame, dt, presentation)) camera.update(frame, dt, presentation, paused); }, () => camera.reset());
  const detachFrame = runtime.subscribe(view => {
    audio.setDistrict(view.route.district);
    audio.update(view.frame, view.input, view.paused, { run: view.run, result: view.result, tick: view.frame.current.simulationTick });
  });
  const detachMenuSounds = typeof document === 'undefined' ? () => {} : attachMenuSounds(host, audio, () => coordinator.state().screen === 'drive');
  const detachMenuMode = coordinator.subscribe(state => ports.input.setMenuMode(state.screen !== 'drive'));
  let appliedCameraPreferences = '';
  const detachAccessibility = coordinator.subscribe(state => {
    const { cameraFovDeg, cameraShakeEnabled, reducedMotion } = state.settings;
    const signature = `${cameraFovDeg}|${cameraShakeEnabled}|${reducedMotion}`;
    if (signature === appliedCameraPreferences) return;
    appliedCameraPreferences = signature;
    camera.setPreferences({ baseFovDeg: cameraFovDeg, shakeEnabled: cameraShakeEnabled, reducedMotion });
  });
  let appliedKeyboard = DEFAULT_KEYBOARD_BINDINGS;
  let appliedGamepad = DEFAULT_GAMEPAD_BINDINGS;
  let bindingWritePending = false;
  const detachBindings = coordinator.subscribe(state => {
    if (bindingWritePending) return;
    const keyboard = state.settings.keyboardBindings || DEFAULT_KEYBOARD_BINDINGS;
    const gamepad = state.settings.gamepadBindings || DEFAULT_GAMEPAD_BINDINGS;
    if (keyboard === appliedKeyboard && gamepad === appliedGamepad) return;
    try {
      ports.input.setBindings(keyboard, gamepad);
      appliedKeyboard = keyboard; appliedGamepad = gamepad;
    } catch (error) { ui.announce(message(error)); }
  });
  const detachBindingChanges = ports.input.onBindingsChanged(bindings => {
    bindingWritePending = true;
    void coordinator.setSettings({ keyboardBindings: bindings.keyboard, gamepadBindings: bindings.gamepad })
      .then(() => { appliedKeyboard = bindings.keyboard; appliedGamepad = bindings.gamepad; })
      .catch(error => ui.announce(message(error)))
      .finally(() => { bindingWritePending = false; });
  });
  // The showroom and the starter gift sit above the menu: they get the gamepad first.
  const detachMenuAction = ports.input.onMenuAction(action => { if (features?.menuAction(action)) return; if (!shop?.menuAction(action)) ui.handleMenuAction(action); });
  const detachInput = ports.input.onAction(action => {
    if (action === 'camera') { camera.cycleView(); return; }
    // Pause (Start) backs out of the showroom or the gift reveal before it touches the menu.
    if (action === 'pause' && features?.menuAction('back')) return;
    if (action === 'pause' && shop?.menuAction('back')) return;
    const screen = coordinator.state().screen;
    try {
      if (screen === 'drive') coordinator.open('pause');
      else if (screen !== 'pause') ui.handleBack();
      else if (screen === 'pause' && !ui.handleBack()) void coordinator.drive()
        .then(() => ports.input.focusDrivingCanvas())
        .catch(error => ui.announce(message(error)));
    } catch (error) { ui.announce(message(error)); }
  });
  const detachFirstControl = ports.input.onFirstControl(device => ports.platform.handle({ type: 'first-control', input: device }));
  let ownerTools: { dispose(): void } | null = null;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    ownerTools?.dispose();
    accountGate?.dispose(); detachOnlineClose(); onlinePanel?.dispose(); features?.dispose(); online.dispose(); shop?.dispose();
    detachAudioUnlock(); detachMenuSounds(); detachFirstControl(); detachInput(); detachMenuAction(); detachBindingChanges(); detachBindings(); detachAccessibility(); detachMenuMode(); detachFrame();
    runtime.setCameraController(null);
    ui.dispose(); coordinator.dispose(); camera.dispose(); audio.dispose(); ports.input.dispose();
  };
  try {
    await coordinator.initialize();
    if (__OWNER_REVIEW__) {
      const { mountOwnerTools } = await import('../owner-tools');
      ownerTools = mountOwnerTools(host, coordinator, runtime, ports.ownerTools?.(coordinator));
    }
    return { coordinator, dispose };
  } catch (error) { dispose(); throw error; }
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Unable to complete the action'; }

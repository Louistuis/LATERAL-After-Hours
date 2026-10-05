import type { EventMode, LightingPreset, QualitySelection } from '../../contracts/runtime-contracts';
import type { ExperienceCoordinator } from '../experience/coordinator';
import type { GameRuntime } from '../core/game-runtime';
import type { BugReportDetails, RecoveryInspection } from '../save/profile-repository';
import type { OwnerProfile } from '../../contracts/owner-review-contracts';
import { EVENTS } from '../../content/events/catalog';

export interface OwnerToolsOptions {
  readonly onExportSave?: () => Promise<Blob>;
  readonly onExportBugReport?: (details: BugReportDetails) => Promise<Blob>;
  readonly onResetCareer?: () => Promise<void>;
  readonly inspectProfileRecovery?: (profile: OwnerProfile) => Promise<RecoveryInspection>;
  readonly onExportRawBackup?: (profile: OwnerProfile) => Promise<Blob>;
  readonly onPlayProfileForSession?: (profile: OwnerProfile) => Promise<void>;
}

/** Owner-only review controls. The importing build target must dynamically load this module only for owner-review. */
export function mountOwnerTools(host: HTMLElement, coordinator: ExperienceCoordinator, runtime: GameRuntime, options: OwnerToolsOptions = {}): { dispose(): void } {
  const style = document.createElement('style'); style.textContent = OWNER_TOOLBAR_CSS; document.head.append(style);
  const root = document.createElement('aside'); root.className = 'owner-tools'; root.setAttribute('aria-label', 'Owner review tools'); host.append(root);
  let open = false, disposed = false, lastSignature = '', localError: string | null = null;
  let sandboxRecovery: RecoveryInspection | null = null, recoveryBusy = false, recoveryRequest = 0;
  const reportDraft: { description: string; reproductionSteps: string; expected: string; observed: string } = { description: '', reproductionSteps: '', expected: '', observed: '' };
  let reportPreview: { blob: Blob; json: string; revision: number; stateFingerprint: string } | null = null;
  let reportRevision = 0, previewBusy = false;
  const render = () => {
    const state = coordinator.state();
    if (!root.dataset.eventId) root.dataset.eventId = `${state.selection.route}:drift-attack`;
    const catalog = runtime.scene.cosmeticsCatalog;
    const unlockedCars = new Set(state.progression.unlockedCars);
    const availableRoutes = runtime.routes();
    const availableRouteIds = new Set(availableRoutes.map(route => route.id));
    const routeOptions = availableRoutes.map(route => `<option value="${route.id}" ${state.selection.route === route.id ? 'selected' : ''}>${route.name}</option>`).join('');
    const selectedEventId = root.dataset.eventId ?? `${state.selection.route}:drift-attack`;
    const eventOptions = EVENTS.map(event => { const routeAvailable = availableRouteIds.has(event.routeId); const rivalAvailable = event.mode !== 'rival-ghost' || state.rivalAvailable; const available = routeAvailable && rivalAvailable; const reason = !routeAvailable ? ' · route unavailable in this build' : !rivalAvailable ? ' · recorded rival unavailable in this build' : ' · provisional'; return `<option value="${event.eventId}" ${selectedEventId === event.eventId ? 'selected' : ''} ${available ? '' : 'disabled'}>${event.routeId} · ${labelMode(event.mode)}${reason}</option>`; }).join('');
    const cosmeticOptions = catalog ? `<h4>Current car cosmetics</h4>${makeCosmeticSelect('paint', catalog.paints, state.cosmetics?.paint)}${makeCosmeticSelect('wheelStyle', catalog.wheelStyles, state.cosmetics?.wheelStyle)}${makeCosmeticSelect('livery', catalog.liveries, state.cosmetics?.livery)}` : '<p>Cosmetics appear when authored car assets load.</p>';
    const recoveryMarkup = options.inspectProfileRecovery ? renderRecoveryMarkup(sandboxRecovery, state.profile === 'sandbox' && state.persistence.state === 'session-only', recoveryBusy, Boolean(options.onExportRawBackup), Boolean(options.onPlayProfileForSession)) : '';
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    const reportMarkup = `<h3>Local bug report</h3><p>Nothing is uploaded. Edit or clear the text fields, then preview the exact allowlisted JSON before downloading.</p><label>Description<textarea data-report-field="description" data-focus-key="report-description" rows="2" maxlength="2000">${escapeHtml(reportDraft.description)}</textarea></label><label>Reproduction steps (one per line)<textarea data-report-field="reproductionSteps" data-focus-key="report-steps" rows="3" maxlength="2000">${escapeHtml(reportDraft.reproductionSteps)}</textarea></label><label>Expected behavior<textarea data-report-field="expected" data-focus-key="report-expected" rows="2" maxlength="1000">${escapeHtml(reportDraft.expected)}</textarea></label><label>Observed behavior<textarea data-report-field="observed" data-focus-key="report-observed" rows="2" maxlength="1000">${escapeHtml(reportDraft.observed)}</textarea></label><button data-focus-key="report-preview" data-action="preview-bug-report" ${previewBusy ? 'disabled' : ''}>${previewBusy ? 'Preparing preview…' : 'Preview local report'}</button>${reportPreview && reportPreview.revision === reportRevision ? `<section class="ot-report-preview" role="region" aria-label="Review local bug report"><h4>Review exact export</h4><p>Only the displayed schema fields will be downloaded. Automatic upload is disabled.</p><textarea readonly tabindex="0" data-focus-key="report-preview-json" aria-label="Exact report JSON preview" rows="12">${escapeHtml(reportPreview.json)}</textarea><div class="ot-row"><button data-focus-key="report-cancel" data-action="cancel-bug-report">Cancel</button><button data-focus-key="report-download" data-action="download-bug-report">Download reviewed report</button></div></section>` : ''}`;
    root.innerHTML = `<button class="ot-toggle" data-focus-key="owner-toggle" aria-controls="owner-tools-panel" aria-expanded="${open}">Owner tools</button>${open ? `<section id="owner-tools-panel" class="ot-panel"><header><h2>Review controls</h2><button data-focus-key="close" data-action="close" aria-label="Close owner tools">×</button></header><p>Build ${escapeHtml(__BUILD__.version)} · ${escapeHtml(__BUILD__.buildId)} · ${escapeHtml(__BUILD__.commit.slice(0,8))}<br>Content ${escapeHtml(__BUILD__.contentHash.slice(0,12))}</p><label>Profile<select data-focus-key="profile" data-select="profile"><option value="career" ${state.profile === 'career' ? 'selected' : ''}>Career</option><option value="sandbox" ${state.profile === 'sandbox' ? 'selected' : ''}>Sandbox · explore available items</option></select></label><label>Car<select data-focus-key="car" data-select="car">${['CAR-01','CAR-02','CAR-04','CAR-05','CAR-06'].map(id => { const unlocked = state.profile === 'sandbox' || unlockedCars.has(id as never); return `<option value="${id}" ${state.selection.car === id ? 'selected' : ''} ${unlocked ? '' : 'disabled'}>${id}${unlocked ? '' : ' · locked'}</option>`; }).join('')}</select></label><label>Route<select data-focus-key="route" data-select="route">${routeOptions}</select></label><label>Event<select data-focus-key="event" data-select="event">${eventOptions}</select></label><div class="ot-row"><button data-action="start-event">Start event</button><button data-action="retry">Restart event</button><button data-action="free">Free drive</button></div><div class="ot-row"><label>Lighting<select data-focus-key="lighting" data-select="lighting"><option value="golden-hour" ${state.selection.lighting === 'golden-hour' ? 'selected' : ''}>Golden hour</option><option value="blue-hour" ${state.selection.lighting === 'blue-hour' ? 'selected' : ''}>Blue hour</option></select></label><label>Graphics<select data-focus-key="quality" data-select="quality"><option value="low" ${state.selection.quality === 'low' ? 'selected' : ''}>Low</option><option value="balanced" ${state.selection.quality === 'balanced' ? 'selected' : ''}>Balanced</option><option value="high" ${state.selection.quality === 'high' ? 'selected' : ''}>High</option><option value="ultra" ${state.selection.quality === 'ultra' ? 'selected' : ''}>Ultra</option><option value="auto" ${state.selection.quality === 'auto' ? 'selected' : ''}>Auto</option></select></label></div>${cosmeticOptions}<div class="ot-row"><button data-action="reset">Reset vehicle</button><button data-action="replay">Replay</button><button data-action="photo">Photo</button><button data-action="capture">Save frame</button></div><h3>Live diagnostics</h3><pre>${diagnostics(state)}</pre><div class="ot-row"><button data-action="save-export">Export save</button><button data-action="reset-career">Export career before reset…</button></div>${recoveryMarkup}${reportMarkup}${localError ? `<p role="alert">${escapeHtml(localError)}</p>` : ''}${state.error ? `<p role="alert">${escapeHtml(state.error)}</p>` : ''}</section>` : ''}`;
    if (focused) root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll:true });
  };
  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button'); if (!target) return;
    const action = target.dataset.action;
    if (!action) { open = !open; render(); if (open) void inspectSandboxRecovery(); return; }
    if (action === 'close') { open = false; render(); return; }
    void perform(action).catch(error => { localError = error instanceof Error ? error.message : 'Owner action failed'; render(); });
  });
  root.addEventListener('change', event => { const target = event.target as HTMLSelectElement; if (!target.matches('[data-select]')) return; void select(target.dataset.select!, target.value).catch(error => { localError = error instanceof Error ? error.message : 'Owner selection failed'; render(); }); });
  root.addEventListener('input', event => { const target = event.target as HTMLTextAreaElement; const field = target.dataset.reportField as keyof typeof reportDraft | undefined; if (!field) return; reportDraft[field] = target.value; reportRevision++; reportPreview = null; root.querySelector('.ot-report-preview')?.remove(); });
  async function select(kind: string, value: string): Promise<void> {
    if (kind === 'profile') {
      const profile = value as OwnerProfile;
      try { await coordinator.switchProfile(profile); }
      catch (error) { if (profile === 'sandbox') await inspectSandboxRecovery(); throw error; }
      if (profile === 'sandbox') await inspectSandboxRecovery();
    }
    else if (kind === 'car') await coordinator.selectCar(value as 'CAR-01'|'CAR-02'|'CAR-04'|'CAR-05'|'CAR-06');
    else if (kind === 'route') { await coordinator.selectRoute(value as never); root.dataset.eventId = `${value}:drift-attack`; }
    else if (kind === 'lighting') await coordinator.setPresentation(value as LightingPreset, coordinator.state().selection.quality);
    else if (kind === 'quality') await coordinator.setPresentation(coordinator.state().selection.lighting, value as QualitySelection);
    else if (kind === 'event') root.dataset.eventId = value;
    else if (['paint','wheelStyle','livery'].includes(kind)) await coordinator.setCosmetics({ ...coordinator.state().cosmetics, [kind]: value });
    render();
  }
  async function inspectSandboxRecovery(): Promise<void> {
    if (!options.inspectProfileRecovery || disposed || !open) return;
    const request = ++recoveryRequest; sandboxRecovery = null; render();
    try {
      const inspection = await options.inspectProfileRecovery('sandbox');
      if (disposed || request !== recoveryRequest || !open) return;
      sandboxRecovery = inspection;
    } catch {
      if (disposed || request !== recoveryRequest || !open) return;
      sandboxRecovery = { status: 'unavailable', code: null, message: 'Sandbox save status could not be checked.', rawBytes: null };
    }
    render();
  }
  async function perform(action: string): Promise<void> {
    localError = null;
    if (action === 'preview-bug-report') {
      if (!options.onExportBugReport) throw new Error('Local bug report export is unavailable.');
      previewBusy = true; render(); const revision = reportRevision;
      try {
        const steps = reportDraft.reproductionSteps.split(/\r?\n/).filter(Boolean);
        const details: BugReportDetails = {
          description: reportDraft.description,
          reproductionSteps: steps.length ? steps : undefined,
          expected: reportDraft.expected || undefined, observed: reportDraft.observed || undefined,
        };
        const blob = await options.onExportBugReport(details);
        const json = await validateBugReport(blob);
        if (revision === reportRevision) reportPreview = { blob, json, revision, stateFingerprint: reportStateFingerprint(coordinator.state()) };
        else throw new Error('Report text changed during preview. Preview it again before downloading.');
      } finally { previewBusy = false; }
    }
    else if (action === 'cancel-bug-report') reportPreview = null;
    else if (action === 'download-bug-report') {
      if (!reportPreview || reportPreview.revision !== reportRevision || reportPreview.stateFingerprint !== reportStateFingerprint(coordinator.state())) throw new Error('Report details changed. Preview the current report before downloading.');
      download(reportPreview.blob, 'lateral-bug-report.json'); reportPreview = null;
    }
    else if (action === 'start-event') { const event = EVENTS.find(item => item.eventId === root.dataset.eventId); if (!event) throw new Error('Choose an event with an available route.'); if (!runtime.routes().some(route => route.id === event.routeId)) throw new Error('This event route is not available in the current build.'); if (event.mode === 'rival-ghost' && !coordinator.state().rivalAvailable) throw new Error('Recorded rival unavailable in this build.'); if (event.routeId !== coordinator.state().selection.route) await coordinator.selectRoute(event.routeId); await coordinator.beginEvent({ mode: event.mode as EventMode, rulesVersion: event.rulesVersion }); }
    else if (action === 'retry') await coordinator.retry();
    else if (action === 'free') coordinator.freeDrive();
    else if (action === 'reset') coordinator.resetVehicle();
    else if (action === 'replay') coordinator.replay();
    else if (action === 'photo') coordinator.photo();
    else if (action === 'capture') { const blob = await coordinator.screenshot(); download(blob, 'lateral-review-frame.png'); }
    else if (action === 'save-export' && options.onExportSave) download(await options.onExportSave(), 'lateral-save-export.json');
    else if (action === 'reset-career' && options.onResetCareer && confirm('Export your career first, then reset this local career profile? This cannot be undone.')) await options.onResetCareer();
    else if (action === 'export-sandbox-backup') {
      if (recoveryBusy) throw new Error('Sandbox recovery is already in progress.');
      if (sandboxRecovery?.status !== 'recovery-required' || !options.onExportRawBackup) throw new Error('There is no damaged sandbox save available to back up.');
      recoveryBusy = true; render();
      try { const backup = await options.onExportRawBackup('sandbox'); if (disposed) return; if (!(backup instanceof Blob)) throw new Error('Stored sandbox backup could not be exported.'); download(backup, 'lateral-sandbox-stored-save-backup.json'); }
      finally { recoveryBusy = false; if (!disposed) render(); }
    }
    else if (action === 'play-sandbox-session') {
      if (recoveryBusy) throw new Error('Sandbox recovery is already in progress.');
      if (sandboxRecovery?.status !== 'recovery-required' || !options.onPlayProfileForSession) throw new Error('Sandbox session recovery is unavailable.');
      recoveryBusy = true; render();
      try { await options.onPlayProfileForSession('sandbox'); }
      finally { recoveryBusy = false; if (!disposed) render(); }
    }
    render();
    if (action === 'preview-bug-report' && reportPreview) {
      const preview = root.querySelector<HTMLElement>('[data-focus-key="report-preview-json"]');
      preview?.scrollIntoView({ block: 'center', behavior: 'auto' });
      preview?.focus({ preventScroll: true });
    }
  }
  const refresh = (): void => {
    const state = coordinator.state();
    if (reportPreview && reportPreview.stateFingerprint !== reportStateFingerprint(state)) reportPreview = null;
    const signature = JSON.stringify([open, state.profile, state.screen, state.selection, state.cosmetics, state.settings, state.persistence, state.error, state.busy]);
    if (open && signature !== lastSignature) { lastSignature = signature; render(); }
    const pre = root.querySelector('pre'); if (pre) pre.textContent = diagnostics(state);
  };
  const detach = coordinator.subscribe(refresh); render();
  const diagnosticsTimer = window.setInterval(() => { const pre = root.querySelector('pre'); if (pre && open) pre.textContent = diagnostics(coordinator.state()); }, 500);
  return { dispose() { if (disposed) return; disposed = true; detach(); clearInterval(diagnosticsTimer); root.remove(); style.remove(); } };
}

export function renderRecoveryMarkup(inspection: RecoveryInspection | null, sessionActive: boolean, busy: boolean, canExport = true, canPlay = true): string {
  if (!inspection) return '<section class="ot-recovery" aria-live="polite" data-recovery-status="checking"><h3>Sandbox save recovery</h3><p>Checking the saved sandbox profile…</p></section>';
  if (inspection.status === 'clean') return '<section class="ot-recovery" aria-live="polite" data-recovery-status="clean"><h3>Sandbox save recovery</h3><p>No recovery is needed for the saved sandbox profile.</p></section>';
  if (inspection.status === 'unavailable') return `<section class="ot-recovery" aria-live="polite" data-recovery-status="unavailable"><h3>Sandbox save recovery</h3><p>${escapeHtml(inspection.message ?? 'Sandbox save status is unavailable.')}</p></section>`;
  const safeMessage = escapeHtml(inspection.message ?? 'The stored sandbox save needs recovery.');
  const code = inspection.code ? `<p>Reason code: <code>${escapeHtml(inspection.code)}</code></p>` : '';
  const sessionMessage = sessionActive ? '<p role="status">Sandbox is active for this session using temporary data. The stored save has not been changed.</p>' : '<p>Download a copy if you want a backup. Playing for this session does not overwrite the stored save.</p>';
  const backup = canExport ? `<button data-action="export-sandbox-backup" ${busy ? 'disabled' : ''}>Download stored save</button>` : '';
  const play = !sessionActive && canPlay ? `<button data-action="play-sandbox-session" ${busy ? 'disabled' : ''}>Play sandbox for this session</button>` : '';
  return `<section class="ot-recovery" aria-live="polite" data-recovery-status="recovery-required"><h3>Sandbox save needs recovery</h3><p>${safeMessage}</p>${code}${sessionMessage}<div class="ot-row">${backup}${play}</div></section>`;
}

function makeCosmeticSelect(kind: string, values: readonly { id: string; name: string }[], selected?: string): string {
  return `<label>${kind}<select data-select="${kind}"><option value="">Default</option>${values.map(value => `<option value="${escapeHtml(value.id)}" ${selected === value.id ? 'selected' : ''}>${escapeHtml(value.name)}</option>`).join('')}</select></label>`;
}
function diagnostics(state: ReturnType<ExperienceCoordinator['state']>): string {
  const current = state.runtime.frame.current;
  return `Build tools are local to this private review target.\nRoute: ${state.runtime.route.id} · Car: ${current.carId}\nSpeed: ${(Math.hypot(current.linearVelocityMS.x,current.linearVelocityMS.z)*3.6).toFixed(1)} km/h · RPM: ${Math.round(current.engineRpm)}\nTick: ${current.simulationTick} · FPS: ${state.runtime.metrics.fps.toFixed(1)}\nPosition: ${current.position.x.toFixed(1)}, ${current.position.y.toFixed(1)}, ${current.position.z.toFixed(1)}`;
}
function labelMode(mode: EventMode): string { return mode === 'drift-attack' ? 'Drift attack' : mode === 'time-trial' ? 'Time trial' : 'Rival ghost'; }
function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]!); }
export async function validateBugReport(blob: Blob): Promise<string> {
  const limit = 2 * 1024 * 1024;
  if (!(blob instanceof Blob) || blob.size > limit) throw new Error('Bug report is invalid or exceeds the 2 MiB limit.');
  let report: unknown;
  try { report = JSON.parse(await blob.text()); } catch { throw new Error('Bug report preview is not valid JSON.'); }
  if (!isObject(report) || !hasExactKeys(report, ['schemaVersion','reportId','identity','profile','selection','settings','timestamp','reproductionSteps','expected','observed','sanitizedDiagnostics','automaticUpload'])) throw new Error('Bug report has fields outside the approved schema.');
  if (report.schemaVersion !== 1 || typeof report.reportId !== 'string' || typeof report.timestamp !== 'string' || !Number.isFinite(Date.parse(report.timestamp)) || (report.profile !== 'career' && report.profile !== 'sandbox') || report.automaticUpload !== false) throw new Error('Bug report identity, profile, timestamp, or upload marker is invalid.');
  const identity = report.identity, selection = report.selection, settings = report.settings;
  if (!isObject(identity) || !hasExactKeys(identity, ['version','buildId','commit','contentHash','target']) || !['version','buildId','commit','contentHash','target'].every(key => typeof identity[key] === 'string')) throw new Error('Bug report build identity is invalid.');
  if (!isObject(selection) || !hasExactKeys(selection, ['car','route','eventId','lighting','quality']) || !['car','route','lighting','quality'].every(key => typeof selection[key] === 'string') || !(typeof selection.eventId === 'string' || selection.eventId === null)) throw new Error('Bug report scene selection is invalid.');
  const requiredSettingKeys = ['masterVolume','musicVolume','sfxVolume','muted','reducedMotion','uiScale','ghostVisible','keyboardBindings','gamepadBindings'];
  const optionalSettingKeys = ['cameraFovDeg','cameraShakeEnabled'];
  const allowedSettingKeys = [...requiredSettingKeys, ...optionalSettingKeys];
  if (!isObject(settings) || !requiredSettingKeys.every(key => Object.hasOwn(settings, key)) || Object.keys(settings).some(key => !allowedSettingKeys.includes(key)) || !['masterVolume','musicVolume','sfxVolume','uiScale'].every(key => typeof settings[key] === 'number' && Number.isFinite(settings[key])) || !['muted','reducedMotion','ghostVisible'].every(key => typeof settings[key] === 'boolean') || !['keyboardBindings','gamepadBindings'].every(key => typeof settings[key] === 'string' && (settings[key] as string).length <= 2048) || (Object.hasOwn(settings, 'cameraFovDeg') && (typeof settings.cameraFovDeg !== 'number' || !Number.isFinite(settings.cameraFovDeg) || settings.cameraFovDeg < 50 || settings.cameraFovDeg > 75)) || (Object.hasOwn(settings, 'cameraShakeEnabled') && typeof settings.cameraShakeEnabled !== 'boolean')) throw new Error('Bug report settings are invalid.');
  if (!Array.isArray(report.reproductionSteps) || report.reproductionSteps.length > 20 || !report.reproductionSteps.every(step => typeof step === 'string' && step.length <= 300) || typeof report.expected !== 'string' || report.expected.length > 1000 || typeof report.observed !== 'string' || report.observed.length > 1000 || !Array.isArray(report.sanitizedDiagnostics) || report.sanitizedDiagnostics.length > 240 || !report.sanitizedDiagnostics.every(line => typeof line === 'string' && line.length <= 800)) throw new Error('Bug report text or diagnostics exceed the approved limits.');
  return JSON.stringify(report, null, 2);
}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key,index) => key === wanted[index]); }
function reportStateFingerprint(state: ReturnType<ExperienceCoordinator['state']>): string {
  return JSON.stringify([state.profile, state.selection, state.settings, state.runtime.mode, state.runtime.route.id, state.runtime.frame.current.carId]);
}
function download(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
export const OWNER_TOOLBAR_WIDTH = 112;
export interface OwnerToolbarRect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; }
/** Shared geometry model for the owner-only toggle, used by source layout tests. */
export function ownerToolbarRect(viewportWidth: number, viewportHeight: number, safeTop = 0, safeLeft = 0, safeRight = 0): OwnerToolbarRect {
  const usableLeft = Math.min(viewportWidth, Math.max(12, safeLeft));
  const usableRight = Math.max(usableLeft, viewportWidth - Math.max(12, safeRight));
  const width = Math.min(OWNER_TOOLBAR_WIDTH, usableRight - usableLeft);
  const left = usableLeft + (usableRight - usableLeft - width) / 2;
  const top = Math.min(Math.max(12, safeTop), Math.max(0, viewportHeight - 44));
  return { left, top, right: left + width, bottom: top + 44 };
}

export const OWNER_TOOLBAR_CSS = `.owner-tools{position:absolute;z-index:10;top:max(12px,env(safe-area-inset-top));left:calc(max(12px,env(safe-area-inset-left)) + (100vw - max(12px,env(safe-area-inset-left)) - max(12px,env(safe-area-inset-right)))/2);transform:translateX(-50%);width:min(${OWNER_TOOLBAR_WIDTH}px,calc(100vw - max(24px,env(safe-area-inset-left) + env(safe-area-inset-right) + 24px)));color:#fff;font:500 13px/1.4 'Chakra Petch',ui-monospace,-apple-system,BlinkMacSystemFont,'Helvetica Neue',system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-shadow:none;pointer-events:none}.ot-toggle,.ot-panel button,.ot-panel select{pointer-events:auto;color:#f6f8f3;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:7px 11px;font:inherit;font-weight:600;transition:background .16s ease,border-color .16s ease}.ot-toggle:hover,.ot-panel button:hover,.ot-panel select:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.3)}.ot-toggle{background:rgba(9,15,17,.66);color:#b4c1bb;font-size:12px;letter-spacing:0;white-space:nowrap;padding:7px 6px;border-radius:99px}.ot-toggle[aria-expanded=true]{color:#141f0a;background:#d8fa72;border-color:transparent}.ot-panel select{appearance:none;-webkit-appearance:none;padding-right:30px;background:rgba(255,255,255,.08) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23d8fa72' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 11px center/10px}.ot-panel option{background:#10191b;color:#f6f8f3}.ot-toggle{width:100%;min-height:44px;box-sizing:border-box;cursor:pointer}.ot-toggle:focus-visible,.ot-panel button:focus-visible,.ot-panel select:focus-visible,.ot-panel textarea:focus-visible{outline:3px solid #d8fa72;outline-offset:2px}.ot-panel{pointer-events:auto;position:absolute;top:44px;left:50%;transform:translateX(-50%);box-sizing:border-box;width:min(380px,calc(100vw - max(24px,env(safe-area-inset-left) + env(safe-area-inset-right) + 24px)));max-height:min(78vh,760px);overflow:auto;background:rgba(9,15,17,.94);-webkit-backdrop-filter:blur(22px) saturate(1.3);backdrop-filter:blur(22px) saturate(1.3);border:1px solid rgba(255,255,255,.16);border-radius:18px;padding:16px;box-shadow:0 30px 80px -20px rgba(0,0,0,.75);scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}.ot-panel header,.ot-row{display:flex;justify-content:space-between;gap:6px;align-items:center}.ot-panel header h2{margin:0;font-size:17px;font-weight:780;letter-spacing:-.01em}.ot-panel h3{margin:1.3em 0 .4em;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8a9a94}.ot-panel h4{margin:1em 0 .2em;font-size:12px;color:#b4c1bb}.ot-panel label{display:block;margin:8px 0;color:#b4c1bb;font-weight:600}.ot-panel select{width:100%;margin-top:4px;min-height:36px;color:#f6f8f3}.ot-panel pre{white-space:pre-wrap;font:11px/1.5 ui-monospace,monospace;background:rgba(255,255,255,.06);border-radius:10px;padding:10px}.ot-panel textarea{display:block;width:100%;margin-top:4px;box-sizing:border-box;color:#f6f8f3;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px 10px;font:inherit}.ot-panel button{cursor:pointer}.ot-row{flex-wrap:wrap}.ot-panel p{color:#b4c1bb;margin:.4em 0}.ot-recovery{margin:12px 0;padding:12px;border:1px solid rgba(240,190,110,.4);border-radius:14px;background:rgba(255,255,255,.04)}.ot-recovery h3{margin:.2em 0 .45em}.ot-recovery[data-recovery-status=clean]{border-color:rgba(216,250,114,.4)}.ot-report-preview{position:relative;z-index:2;margin:10px -4px;padding:12px;border:1px solid rgba(240,190,110,.6);border-radius:14px;background:rgba(255,255,255,.05)}.ot-report-preview textarea{max-height:38vh;resize:vertical;font:10px/1.35 ui-monospace,monospace}.ot-toggle,.ot-panel button{border-radius:0;letter-spacing:.08em;text-transform:uppercase;font-size:11px;background-color:rgba(47,184,173,.1);border-color:rgba(130,205,196,.3);clip-path:polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,7px 100%,0 calc(100% - 7px))}.ot-toggle{color:#b7c5bf;background:rgba(5,11,13,.78)}.ot-toggle[aria-expanded=true]{color:#0d1505;background:#d8fa72}.ot-toggle:hover,.ot-panel button:hover{border-color:#d8fa72;color:#d8fa72}.ot-toggle[aria-expanded=true]:hover{color:#0d1505}.ot-toggle:focus-visible,.ot-panel button:focus-visible{outline-offset:-4px;outline-width:2px}.ot-panel select,.ot-panel textarea,.ot-panel pre,.ot-recovery,.ot-report-preview{border-radius:0}.ot-panel select{border-color:rgba(130,205,196,.3)}.ot-panel{border-radius:0;border-color:rgba(130,205,196,.3);background:linear-gradient(160deg,rgba(10,36,40,.96),rgba(4,10,12,.97));clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,16px 100%,0 calc(100% - 16px))}.ot-panel header h2{font:800 26px/1 'Big Shoulders Stencil Display','Big Shoulders Display','Arial Narrow',sans-serif;letter-spacing:.04em;text-transform:uppercase}.ot-panel h3{color:#2fb8ad;letter-spacing:.22em}.ot-panel label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#b7c5bf}.ot-panel textarea{text-transform:none;letter-spacing:0}`;

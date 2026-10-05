import type { DataStore, PlatformTarget, RouteId, SaveEnvelope, SavedGhost } from '../../contracts/runtime-contracts';
import type { CandidateIdentity, LocalBugReport, LocalBugReportSettings, OwnerProfile, OwnerSelection } from '../../contracts/owner-review-contracts';
import type { ExperienceSettings, ProfileRecord, ProfileRepository, ProfileSelection } from '../experience/coordinator';
import { ASSIST_SETTINGS_VERSION, DEFAULT_PLAYER_ASSIST, isAssistLevel, migrateAssistLevel, VEHICLE_TUNES, type TunePresetId, type VehicleTune } from '../physics';
import { validateVehicleTune } from '../vehicle/tune-identity';
import { detectDeviceProfile } from '../platform/device-profile';
import { DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS, validateBindings } from '../input';
import { parseSaveEnvelope, SaveValidationError, serializeSaveEnvelope, SAVE_SCHEMA_VERSION, utf8Bytes, type SaveFailureCode } from './envelope';

export interface PersistenceStatus {
  readonly state: 'persistent' | 'session-only';
  readonly warning: string | null;
}
export interface RecoveryInspection {
  readonly status: 'clean' | 'recovery-required' | 'unavailable';
  readonly code: SaveFailureCode | null;
  readonly message: string | null;
  readonly rawBytes: number | null;
}
export type ProfileRepositoryWithStatus = Omit<ProfileRepository, 'getPersistenceStatus'> & {
  getPersistenceStatus(profile?: OwnerProfile): PersistenceStatus;
  getProgression(profile: OwnerProfile): ProfileProgression;
  getSavedGhost(profile: OwnerProfile, route: RouteId): SavedGhost | null;
  applyCareerTransaction(mutator: (envelope: SaveEnvelope) => SaveEnvelope): Promise<void>;
  exportProfileSave(profile: OwnerProfile): Promise<Blob>;
  previewProfileImport(profile: OwnerProfile, file: Blob): Promise<{ compatible: boolean; warning: string | null }>;
  importProfileSave(profile: OwnerProfile, file: Blob, overwriteConfirmed: boolean): Promise<void>;
  resetProfile(profile: OwnerProfile, confirmed: boolean, backupExported: boolean): Promise<void>;
  inspectRecovery(profile: OwnerProfile): Promise<RecoveryInspection>;
  exportRawBackup(profile: OwnerProfile): Promise<Blob>;
  startSessionOnlyRecovery(profile: OwnerProfile, explicitConsent: boolean): Promise<ProfileRecord>;
  resetAfterRecovery(profile: OwnerProfile, confirmed: boolean): Promise<void>;
};
export interface BugDiagnostic { readonly timestampMs: number; readonly message: string; }
export interface BugReportDetails { readonly description: string; readonly reproductionSteps?: readonly string[]; readonly expected?: string; readonly observed?: string; }
export interface ProfileProgression {
  readonly garageCredits: number;
  readonly unlockedCars: readonly SaveEnvelope['selectedCar'][];
  readonly bestResults: SaveEnvelope['bestResults'];
}

const profiles: readonly OwnerProfile[] = ['career', 'sandbox'];
const carIds = ['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06'] as const;
const routeIds = ['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02'] as const;
const tunes: readonly TunePresetId[] = ['Grip', 'Balanced', 'Drift'];
const lightings = ['golden-hour', 'blue-hour'] as const;
const qualities = ['low', 'balanced', 'high', 'ultra', 'auto'] as const;
const DEFAULT_SETTINGS: ExperienceSettings = {
  masterVolume: 1, musicVolume: 0.5, sfxVolume: 1, engineVolume: 0.45, muted: false,
  reducedMotion: false, cameraFovDeg: 58, cameraShakeEnabled: false,
  uiScale: 1, ghostVisible: true, keyboardBindings: '', gamepadBindings: '',
  tutorialCompleted: false, tutorialSkipped: false,
  assistLevel: DEFAULT_PLAYER_ASSIST, assistHintSeen: false, assistVersion: ASSIST_SETTINGS_VERSION,
};

/** Career and sandbox use separate durable keys with no cross-profile fallback or migration. */
export function createProfileRepository(store: DataStore, target: PlatformTarget): ProfileRepositoryWithStatus {
  const cache = new Map<OwnerProfile, SaveEnvelope>();
  const sessionRecords = new Map<OwnerProfile, ProfileRecord>();
  const statuses = new Map<OwnerProfile, PersistenceStatus>(profiles.map(profile => [profile, { state: 'persistent', warning: null }]));
  const writes = new Map<OwnerProfile, Promise<void>>();
  const generations = new Map<OwnerProfile, number>(profiles.map(profile => [profile, 0]));
  const recoveryRaw = new Map<OwnerProfile, string>();
  const recoveryErrors = new Map<OwnerProfile, SaveValidationError>();
  const recoverySessionOnly = new Set<OwnerProfile>();
  const rawBackupExports = new Map<OwnerProfile, { serialized: string; generation: number }>();

  async function readEnvelope(profile: OwnerProfile): Promise<SaveEnvelope | null> {
    const generation = generations.get(profile) ?? 0;
    const result = await store.read(key(target, profile));
    if ((generations.get(profile) ?? 0) !== generation) return cache.get(profile) ?? null;
    if (result.status === 'unavailable') {
      markSessionOnly(profile, result.reason);
      return cache.get(profile) ?? null;
    }
    if (result.status === 'missing') {
      clearRecovery(profile);
      return null;
    }
    // Any validation error propagates; callers must not convert corrupt/future data to defaults.
    try {
      const envelope = parseSaveEnvelope(result.serialized);
      decodeRecord(envelope, profile);
      clearRecovery(profile);
      return envelope;
    } catch (error) {
      const validation = asSaveValidationError(error);
      recoveryRaw.set(profile, result.serialized);
      recoveryErrors.set(profile, validation);
      rawBackupExports.delete(profile);
      throw validation;
    }
  }

  async function load(profile: OwnerProfile): Promise<ProfileRecord | null> {
    assertProfile(profile);
    if (recoverySessionOnly.has(profile)) return cloneRecord(sessionRecords.get(profile) ?? defaultRecord(profile));
    const generation = generations.get(profile) ?? 0;
    const envelope = await readEnvelope(profile);
    if ((generations.get(profile) ?? 0) !== generation && recoverySessionOnly.has(profile)) {
      return cloneRecord(sessionRecords.get(profile) ?? defaultRecord(profile));
    }
    if (!envelope) return sessionRecords.get(profile) ?? null;
    cache.set(profile, envelope);
    const record = decodeRecord(envelope, profile);
    sessionRecords.set(profile, record);
    return cloneRecord(record);
  }

  async function save(record: ProfileRecord): Promise<void> {
    assertProfile(record.profile);
    validateRecord(record);
    const profile = record.profile;
    const previous = writes.get(profile) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      // Prefer cached state after a successful load to preserve progression without a second read.
      let envelope = cache.get(profile);
      if (recoveryErrors.has(profile) && !recoverySessionOnly.has(profile)) throw recoveryErrors.get(profile)!;
      if (recoverySessionOnly.has(profile)) {
        envelope = encodeRecord(cache.get(profile) ?? emptyEnvelope(defaultRecord(profile)), record);
        cache.set(profile, envelope);
        sessionRecords.set(profile, cloneRecord(record));
        return;
      }
      if (!envelope) envelope = await readEnvelope(profile) ?? emptyEnvelope(record);
      envelope = encodeRecord(envelope, record);
      const serialized = serializeSaveEnvelope(envelope);
      sessionRecords.set(profile, cloneRecord(record));
      cache.set(profile, envelope);

      // Once a read was denied, keep the session fallback and never write defaults over unknown data.
      if (statuses.get(profile)?.state === 'session-only') return;
      const result = await store.write(key(target, profile), serialized);
      if (result.status === 'unavailable') {
        markSessionOnly(profile, result.reason);
        return;
      }
      clearRecovery(profile, true);
      statuses.set(profile, { state: 'persistent', warning: null });
    });
    writes.set(profile, operation);
    try { await operation; }
    finally { if (writes.get(profile) === operation) writes.delete(profile); }
  }

  async function applyCareerTransaction(mutator: (envelope: SaveEnvelope) => SaveEnvelope): Promise<void> {
    const profile: OwnerProfile = 'career';
    const previous = writes.get(profile) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (recoveryErrors.has(profile) && !recoverySessionOnly.has(profile)) throw recoveryErrors.get(profile)!;
      let envelope = cache.get(profile);
      if (recoverySessionOnly.has(profile)) {
        envelope = cache.get(profile) ?? emptyEnvelope(defaultRecord(profile));
        const updated = mutator(envelope);
        if (!updated || typeof updated !== 'object') throw new SaveValidationError('incompatible', 'Save transaction returned no envelope');
        if (updated === envelope) return;
        const next = { ...updated, schemaVersion: SAVE_SCHEMA_VERSION, revision: envelope.revision + 1, updatedAtIso: new Date().toISOString() };
        const validated = parseSaveEnvelope(serializeSaveEnvelope(next));
        cache.set(profile, validated);
        sessionRecords.set(profile, decodeRecord(validated, profile));
        return;
      }
      if (!envelope) envelope = await readEnvelope(profile) ?? emptyEnvelope(defaultRecord(profile));
      const updated = mutator(envelope);
      if (!updated || typeof updated !== 'object') throw new SaveValidationError('incompatible', 'Save transaction returned no envelope');
      if (updated === envelope) return;
      const next = { ...updated, schemaVersion: SAVE_SCHEMA_VERSION, revision: envelope.revision + 1, updatedAtIso: new Date().toISOString() };
      const serialized = serializeSaveEnvelope(next);
      const validated = parseSaveEnvelope(serialized);
      cache.set(profile, validated);
      sessionRecords.set(profile, decodeRecord(validated, profile));
      if (statuses.get(profile)?.state === 'session-only') return;
      const result = await store.write(key(target, profile), serialized);
      if (result.status === 'unavailable') markSessionOnly(profile, result.reason);
      else { clearRecovery(profile, true); statuses.set(profile, { state: 'persistent', warning: null }); }
    });
    writes.set(profile, operation);
    try { await operation; }
    finally { if (writes.get(profile) === operation) writes.delete(profile); }
  }

  async function exportProfileSave(profile: OwnerProfile): Promise<Blob> {
    assertProfile(profile);
    if (recoverySessionOnly.has(profile)) {
      const sessionEnvelope = cache.get(profile) ?? emptyEnvelope(defaultRecord(profile));
      return new Blob([serializeSaveEnvelope(sessionEnvelope)], { type: 'application/json' });
    }
    const envelope = await readEnvelope(profile) ?? cache.get(profile) ?? emptyEnvelope(defaultRecord(profile));
    cache.set(profile, envelope);
    const record = decodeRecord(envelope, profile);
    return new Blob([serializeSaveEnvelope(encodeRecord(envelope, record))], { type: 'application/json' });
  }

  async function previewProfileImport(profile: OwnerProfile, file: Blob): Promise<{ compatible: boolean; warning: string | null }> {
    try {
      const envelope = await readImport(profile, file);
      decodeRecord(envelope, profile);
      return { compatible: true, warning: envelope.ghosts.length ? 'Import replaces the selected profile and includes ghost data.' : 'Import replaces the selected profile.' };
    } catch (error) {
      return { compatible: false, warning: validationMessage(error) };
    }
  }

  async function importProfileSave(profile: OwnerProfile, file: Blob, overwriteConfirmed: boolean): Promise<void> {
    assertProfile(profile);
    if (!overwriteConfirmed) throw new Error('Import requires explicit overwrite confirmation');
    const imported = await readImport(profile, file);
    const record = decodeRecord(imported, profile);
    const previous = writes.get(profile) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      let existing: SaveEnvelope | null = null;
      if (recoveryErrors.has(profile)) {
        await prepareRawReplacement(profile, overwriteConfirmed);
      } else existing = await readEnvelope(profile);
      if (existing && !overwriteConfirmed) throw new Error('Import requires explicit overwrite confirmation');
      const next = { ...imported, revision: (existing?.revision ?? imported.revision) + 1, updatedAtIso: new Date().toISOString() };
      const serialized = serializeSaveEnvelope(next);
      cache.set(profile, next);
      sessionRecords.set(profile, record);
      if (statuses.get(profile)?.state === 'session-only' && !recoveryErrors.has(profile)) return;
      if (!recoveryErrors.has(profile)) generations.set(profile, (generations.get(profile) ?? 0) + 1);
      const result = await store.write(key(target, profile), serialized);
      if (result.status === 'unavailable') {
        markSessionOnly(profile, result.reason);
        if (recoveryErrors.has(profile)) throw new Error('The replacement could not be saved. Your original stored save is unchanged.');
      }
      else { clearRecovery(profile, true); statuses.set(profile, { state: 'persistent', warning: null }); }
    });
    writes.set(profile, operation);
    try { await operation; }
    finally { if (writes.get(profile) === operation) writes.delete(profile); }
  }

  async function resetProfile(profile: OwnerProfile, confirmed: boolean, backupExported: boolean): Promise<void> {
    assertProfile(profile);
    if (!confirmed || !backupExported) throw new Error('Profile reset requires explicit confirmation after exporting a backup');
    const previous = writes.get(profile) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      let existing: SaveEnvelope | null = null;
      if (recoveryErrors.has(profile)) {
        await prepareRawReplacement(profile, confirmed && backupExported);
      }
      else existing = await readEnvelope(profile);
      let reset = emptyEnvelope(defaultRecord(profile));
      reset = encodeRecord(reset, defaultRecord(profile));
      reset = { ...reset, revision: (existing?.revision ?? 0) + 1, updatedAtIso: new Date().toISOString() };
      const serialized = serializeSaveEnvelope(reset);
      cache.set(profile, reset);
      sessionRecords.set(profile, decodeRecord(reset, profile));
      if (statuses.get(profile)?.state === 'session-only' && !recoveryErrors.has(profile)) return;
      if (!recoveryErrors.has(profile)) generations.set(profile, (generations.get(profile) ?? 0) + 1);
      const result = await store.write(key(target, profile), serialized);
      if (result.status === 'unavailable') {
        markSessionOnly(profile, result.reason);
        if (recoveryErrors.has(profile)) throw new Error('The reset could not be saved. Your original stored save is unchanged.');
      }
      else { clearRecovery(profile, true); statuses.set(profile, { state: 'persistent', warning: null }); }
    });
    writes.set(profile, operation);
    try { await operation; }
    finally { if (writes.get(profile) === operation) writes.delete(profile); }
  }

  async function inspectRecovery(profile: OwnerProfile): Promise<RecoveryInspection> {
    assertProfile(profile);
    if (recoverySessionOnly.has(profile)) return inspectCachedRecovery(profile);
    const generation = generations.get(profile) ?? 0;
    let result;
    try { result = await store.read(key(target, profile)); }
    catch { return { status: 'unavailable', code: null, message: 'Save storage could not be read.', rawBytes: null }; }
    if ((generations.get(profile) ?? 0) !== generation) return inspectCachedRecovery(profile);
    if (result.status === 'unavailable') {
      markSessionOnly(profile, result.reason);
      return { status: 'unavailable', code: null, message: 'Save storage is unavailable.', rawBytes: null };
    }
    if (result.status === 'missing') {
      clearRecovery(profile);
      return { status: 'clean', code: null, message: null, rawBytes: null };
    }
    try {
      const envelope = parseSaveEnvelope(result.serialized);
      decodeRecord(envelope, profile);
      clearRecovery(profile);
      cache.set(profile, envelope);
      sessionRecords.set(profile, decodeRecord(envelope, profile));
      return { status: 'clean', code: null, message: null, rawBytes: null };
    } catch (error) {
      const validation = asSaveValidationError(error);
      recoveryRaw.set(profile, result.serialized);
      recoveryErrors.set(profile, validation);
      rawBackupExports.delete(profile);
      return { status: 'recovery-required', code: validation.code, message: safeRecoveryMessage(validation.code), rawBytes: utf8Bytes(result.serialized) };
    }
  }

  async function exportRawBackup(profile: OwnerProfile): Promise<Blob> {
    assertProfile(profile);
    const generation = generations.get(profile) ?? 0;
    let serialized = recoveryRaw.get(profile);
    const current = await store.read(key(target, profile));
    if ((generations.get(profile) ?? 0) !== generation) throw new Error('Raw backup export was superseded by a newer profile action');
    if (current.status !== 'found') throw new Error(current.status === 'missing' ? 'There is no stored save to back up' : 'Save storage is unavailable');
    if (serialized !== undefined && serialized !== current.serialized) {
      rawBackupExports.delete(profile);
      await inspectRecovery(profile);
      throw new Error('The stored save changed after inspection; inspect it again before exporting');
    }
    if (serialized === undefined) {
      serialized = current.serialized;
      recoveryRaw.set(profile, serialized);
      try { decodeRecord(parseSaveEnvelope(serialized), profile); }
      catch (error) { recoveryErrors.set(profile, asSaveValidationError(error)); }
    }
    if (!recoveryErrors.has(profile)) throw new Error('Raw backup is only available while a save requires recovery');
    if ((generations.get(profile) ?? 0) !== generation) throw new Error('Raw backup export was superseded by a newer profile action');
    rawBackupExports.set(profile, { serialized, generation });
    return new Blob([serialized], { type: 'application/octet-stream' });
  }

  async function startSessionOnlyRecovery(profile: OwnerProfile, explicitConsent: boolean): Promise<ProfileRecord> {
    assertProfile(profile);
    if (explicitConsent !== true) throw new Error('Session-only recovery requires explicit consent');
    let inspection: RecoveryInspection | null = null;
    if (!recoveryErrors.has(profile) && !recoveryRaw.has(profile)) inspection = await inspectRecovery(profile);
    if (!recoveryErrors.has(profile) && !recoveryRaw.has(profile) && inspection?.status !== 'unavailable') throw new Error('No recoverable save was found');
    const previousGeneration = generations.get(profile) ?? 0;
    generations.set(profile, previousGeneration + 1);
    const backup = rawBackupExports.get(profile);
    if (backup?.generation === previousGeneration) rawBackupExports.set(profile, { ...backup, generation: previousGeneration + 1 });
    recoverySessionOnly.add(profile);
    const fallback = defaultRecord(profile);
    const envelope = encodeRecord(emptyEnvelope(fallback), fallback);
    cache.set(profile, envelope);
    sessionRecords.set(profile, cloneRecord(fallback));
    markSessionOnly(profile, 'the stored save is preserved and unavailable for this session');
    return cloneRecord(fallback);
  }

  async function resetAfterRecovery(profile: OwnerProfile, confirmed: boolean): Promise<void> {
    assertProfile(profile);
    const previous = writes.get(profile) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (!confirmed) throw new Error('Recovery reset requires explicit confirmation');
      const generation = await prepareRawReplacement(profile, true);
      const fallback = defaultRecord(profile);
      let reset = encodeRecord(emptyEnvelope(fallback), fallback);
      reset = { ...reset, revision: 1, updatedAtIso: new Date().toISOString() };
      const serialized = serializeSaveEnvelope(reset);
      const result = await store.write(key(target, profile), serialized);
      if ((generations.get(profile) ?? 0) !== generation) throw new Error('Recovery reset was superseded by a newer profile action');
      if (result.status === 'unavailable') {
        cache.set(profile, reset);
        sessionRecords.set(profile, cloneRecord(fallback));
        recoverySessionOnly.add(profile);
        markSessionOnly(profile, result.reason);
        throw new Error('The reset could not be saved. Your original stored save is unchanged.');
      }
      clearRecovery(profile);
      cache.set(profile, reset);
      sessionRecords.set(profile, cloneRecord(fallback));
      statuses.set(profile, { state: 'persistent', warning: null });
    });
    writes.set(profile, operation);
    try { await operation; }
    finally { if (writes.get(profile) === operation) writes.delete(profile); }
  }

  function requireRawBackup(profile: OwnerProfile, confirmed: boolean): void {
    const backup = rawBackupExports.get(profile);
    if (!confirmed || !backup || backup.serialized !== recoveryRaw.get(profile) || backup.generation !== generations.get(profile)) {
      throw new Error('Replacing this save requires exporting a raw backup and confirming the overwrite');
    }
  }

  async function verifyRawBackup(profile: OwnerProfile): Promise<void> {
    const backup = rawBackupExports.get(profile);
    if (!backup) throw new Error('Export a raw backup before replacing this save');
    const generation = generations.get(profile) ?? 0;
    const current = await store.read(key(target, profile));
    if ((generations.get(profile) ?? 0) !== generation) throw new Error('Backup validation was superseded by a newer profile action');
    if (current.status !== 'found' || current.serialized !== backup.serialized) {
      rawBackupExports.delete(profile);
      throw new Error('The stored save changed after backup; inspect and export it again');
    }
  }

  async function prepareRawReplacement(profile: OwnerProfile, confirmed: boolean): Promise<number> {
    requireRawBackup(profile, confirmed);
    await verifyRawBackup(profile);
    const generation = (generations.get(profile) ?? 0) + 1;
    generations.set(profile, generation);
    const backup = rawBackupExports.get(profile)!;
    rawBackupExports.set(profile, { ...backup, generation });
    return generation;
  }

  function clearRecovery(profile: OwnerProfile, invalidatePending = false): void {
    recoveryRaw.delete(profile);
    recoveryErrors.delete(profile);
    recoverySessionOnly.delete(profile);
    rawBackupExports.delete(profile);
    if (invalidatePending) generations.set(profile, (generations.get(profile) ?? 0) + 1);
  }

  function inspectCachedRecovery(profile: OwnerProfile): RecoveryInspection {
    const error = recoveryErrors.get(profile);
    if (!error) return { status: 'clean', code: null, message: null, rawBytes: null };
    const raw = recoveryRaw.get(profile);
    return { status: 'recovery-required', code: error.code, message: safeRecoveryMessage(error.code), rawBytes: raw === undefined ? null : utf8Bytes(raw) };
  }

  const repository = {
    load,
    save,
    applyCareerTransaction,
    inspectRecovery,
    exportRawBackup,
    startSessionOnlyRecovery,
    resetAfterRecovery,
    getProgression(profile: OwnerProfile): ProfileProgression {
      assertProfile(profile);
      const envelope = cache.get(profile);
      if (!envelope) return { garageCredits: 0, unlockedCars: profile === 'sandbox' ? carIds : ['CAR-01'], bestResults: [] };
      return {
        garageCredits: envelope.garageCredits,
        unlockedCars: profile === 'sandbox' ? carIds : [...envelope.unlockedCars],
        bestResults: envelope.bestResults.map(result => ({ ...result })),
      };
    },
    getSavedGhost(profile: OwnerProfile, route: RouteId) {
      assertProfile(profile);
      const ghost = cache.get(profile)?.ghosts.find(candidate => candidate.header.routeId === route);
      return ghost ? { header: { ...ghost.header }, compressedSnapshots: ghost.compressedSnapshots } : null;
    },
    getPersistenceStatus(profile?: OwnerProfile): PersistenceStatus {
      if (profile) return statuses.get(profile) ?? { state: 'persistent', warning: null };
      const values = [...statuses.values()];
      const failed = values.find(status => status.state === 'session-only');
      return failed ?? { state: 'persistent', warning: null };
    },
  };
  // Owner-only file import/export and factory reset are stripped from all player targets.
  const ownerCapabilities = typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__ ? {
    exportProfileSave,
    previewProfileImport,
    importProfileSave,
    resetProfile,
  } : {};
  return { ...repository, ...ownerCapabilities } as ProfileRepositoryWithStatus;

  function markSessionOnly(profile: OwnerProfile, reason: string): void {
    statuses.set(profile, { state: 'session-only', warning: `Progress is stored for this browser session only: ${reason.slice(0, 160)}` });
  }
}

/** Creates a local, bounded report. It never uploads and removes URL/token-like values from diagnostics. */
export async function exportBugReport(
  profile: OwnerProfile,
  identity: CandidateIdentity,
  selection: OwnerSelection,
  details: BugReportDetails,
  diagnostics: readonly BugDiagnostic[],
  settings: LocalBugReportSettings,
): Promise<Blob> {
  assertProfile(profile);
  const reportSettings = validateReportSettings(settings);
  const now = Date.now();
  const recent = diagnostics.filter(item => Number.isFinite(item.timestampMs) && item.timestampMs <= now && now - item.timestampMs <= 60_000)
    .slice(-240).map(item => sanitizeDiagnostic(item.message));
  const description = sanitizeReportField(details.description, 2_000);
  const steps = (details.reproductionSteps ?? description.split(/\r?\n/)).map(step => sanitizeReportField(step, 300)).filter(Boolean).slice(0, 20);
  const report: LocalBugReport = {
    schemaVersion: 1,
    reportId: createId(),
    identity: { ...identity },
    profile,
    selection: { ...selection },
    settings: reportSettings,
    timestamp: new Date(now).toISOString(),
    reproductionSteps: steps,
    expected: sanitizeReportField(details.expected ?? 'Not provided', 1_000),
    observed: sanitizeReportField(details.observed ?? (description || 'Not provided'), 1_000),
    sanitizedDiagnostics: recent,
    automaticUpload: false,
  };
  const serialized = JSON.stringify(report, null, 2);
  if (new TextEncoder().encode(serialized).byteLength > 2 * 1024 * 1024) throw new Error('Bug report exceeds the 2 MiB limit');
  return new Blob([serialized], { type: 'application/json' });
}

function defaultRecord(profile: OwnerProfile): ProfileRecord {
  return { profile, selection: { car: 'CAR-01', route: 'HW-01', tune: 'Balanced', lighting: 'golden-hour', quality: detectDeviceProfile().defaultSelection }, settings: DEFAULT_SETTINGS };
}

export function profileStorageKey(target: PlatformTarget, profile: OwnerProfile): string {
  assertProfile(profile);
  return key(target, profile);
}

async function readImport(profile: OwnerProfile, file: Blob): Promise<SaveEnvelope> {
  assertProfile(profile);
  if (!(file instanceof Blob) || file.size > 512 * 1024) throw new SaveValidationError('oversized', 'Import file exceeds the 512 KiB save limit');
  const envelope = parseSaveEnvelope(await file.text());
  if (envelope.settings['profile.profile'] !== profile) throw new SaveValidationError('incompatible', 'Import belongs to a different or unknown profile namespace');
  return envelope;
}

function sanitizeDiagnostic(value: string): string {
  return sanitizeText(value, 800)
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/\b(token|auth|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
function sanitizeReportField(value: string, limit: number): string {
  return sanitizeText(value, limit)
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/\b(token|auth|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
function validateReportSettings(settings: LocalBugReportSettings): LocalBugReportSettings {
  if (!settings || typeof settings !== 'object' ||
      !between(settings.masterVolume, 0, 1) || !between(settings.musicVolume, 0, 1) || !between(settings.sfxVolume, 0, 1) ||
      typeof settings.muted !== 'boolean' || typeof settings.reducedMotion !== 'boolean' || typeof settings.ghostVisible !== 'boolean' ||
      settings.cameraFovDeg !== undefined && !between(settings.cameraFovDeg, 50, 75) ||
      settings.cameraShakeEnabled !== undefined && typeof settings.cameraShakeEnabled !== 'boolean' ||
      !between(settings.uiScale, 0.75, 1.5) || typeof settings.keyboardBindings !== 'string' || typeof settings.gamepadBindings !== 'string' ||
      settings.keyboardBindings.length > 2048 || settings.gamepadBindings.length > 2048) {
    throw new Error('Bug report settings are invalid or exceed their limits');
  }
  validateBindingPair(settings.keyboardBindings, settings.gamepadBindings);
  return {
    masterVolume: settings.masterVolume, musicVolume: settings.musicVolume, sfxVolume: settings.sfxVolume,
    muted: settings.muted, reducedMotion: settings.reducedMotion,
    ...(settings.cameraFovDeg === undefined ? {} : { cameraFovDeg: settings.cameraFovDeg }),
    ...(settings.cameraShakeEnabled === undefined ? {} : { cameraShakeEnabled: settings.cameraShakeEnabled }),
    uiScale: settings.uiScale, ghostVisible: settings.ghostVisible,
    keyboardBindings: settings.keyboardBindings, gamepadBindings: settings.gamepadBindings,
  };
}
function sanitizeText(value: string, maxLength: number): string {
  let clean = '';
  for (const character of String(value)) {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) continue;
    clean += character;
  }
  return clean.trim().slice(0, maxLength);
}
function createId(): string {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}
function validationMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return 'Import could not be validated';
}
function asSaveValidationError(error: unknown): SaveValidationError {
  if (error instanceof SaveValidationError) return error;
  return new SaveValidationError('incompatible', validationMessage(error));
}
function safeRecoveryMessage(code: SaveFailureCode): string {
  switch (code) {
    case 'future-version': return 'This save was created by a newer game version.';
    case 'oversized': return 'This save is larger than the supported size limit.';
    case 'corrupt': return 'This save is damaged and could not be validated.';
    case 'incompatible': return 'This save contains unsupported or invalid data.';
  }
}

function key(target: PlatformTarget, profile: OwnerProfile): string {
  return `lateral:${target}:${profile}:v1`;
}

function emptyEnvelope(record: ProfileRecord): SaveEnvelope {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION, revision: 0, updatedAtIso: new Date().toISOString(),
    garageCredits: 0, selectedCar: record.selection.car, unlockedCars: [record.selection.car],
    bestResults: [], settings: {}, cosmetics: {}, appliedRewardOperationIds: [], ghosts: [],
  };
}

function encodeRecord(previous: SaveEnvelope, record: ProfileRecord): SaveEnvelope {
  const settings: Record<string, string | number | boolean> = {
    ...previous.settings,
    'profile.profile': record.profile,
    'profile.route': record.selection.route,
    'profile.tune': record.selection.tune,
    'profile.lighting': record.selection.lighting,
    'profile.quality': record.selection.quality,
  };
  for (const name of ['id', 'frontMuScale', 'rearMuScale', 'springScale', 'steeringScale', 'engineScale', 'handbrakeRearMuScale', 'rearDiffLock', 'frontBrakeBias']) {
    delete settings[`profile.customTune.${name}`];
  }
  const customTune = (record.selection as ProfileSelection & { readonly customTune?: VehicleTune }).customTune;
  if (customTune) {
    const tune = checkedCustomTune(customTune);
    for (const [name, value] of Object.entries(tune)) settings[`profile.customTune.${name}`] = value;
  }
  for (const [name, value] of Object.entries(record.settings ?? {})) if (value !== undefined) settings[`experience.${name}`] = value;
  if (record.settings?.tutorialCompleted === true) settings['experience.tutorialSkipped'] = false;
  const cosmetics = { ...previous.cosmetics };
  for (const [name, value] of Object.entries(record.cosmetics ?? {})) {
    if (value !== undefined) cosmetics[`profile.${name}`] = value;
  }
  return {
    ...previous,
    schemaVersion: SAVE_SCHEMA_VERSION,
    revision: previous.revision + 1,
    updatedAtIso: new Date().toISOString(),
    selectedCar: record.selection.car,
    unlockedCars: [...new Set([...previous.unlockedCars, record.selection.car])],
    settings,
    cosmetics,
  };
}

function decodeRecord(envelope: SaveEnvelope, profile: OwnerProfile): ProfileRecord {
  const settings = envelope.settings;
  if (settings['profile.profile'] !== undefined && settings['profile.profile'] !== profile) {
    throw new SaveValidationError('incompatible', 'Saved profile does not match its storage namespace');
  }
  const route = enumSetting(settings['profile.route'], routeIds, 'HW-01', 'route');
  const tune = enumSetting(settings['profile.tune'], tunes, 'Balanced', 'tune');
  const lighting = enumSetting(settings['profile.lighting'], lightings, 'golden-hour', 'lighting');
  const quality = enumSetting(settings['profile.quality'], qualities, detectDeviceProfile().defaultSelection, 'quality');
  const car = enumSetting(envelope.selectedCar, carIds, 'CAR-01', 'car');
  const customTune = decodeCustomTune(settings, car, tune);
  const selection = { car, route, tune, lighting, quality, ...(customTune ? { customTune } : {}) } as ProfileSelection;
  const keyboardBindings = stringSetting(settings['experience.keyboardBindings'], 'keyboard');
  const gamepadBindings = stringSetting(settings['experience.gamepadBindings'], 'gamepad');
  const tutorialCompleted = booleanSetting(settings['experience.tutorialCompleted'], DEFAULT_SETTINGS.tutorialCompleted);
  const tutorialSkipped = !tutorialCompleted && booleanSetting(settings['experience.tutorialSkipped'], DEFAULT_SETTINGS.tutorialSkipped);
  validateBindingPair(keyboardBindings, gamepadBindings);
  const record: ProfileRecord = {
    profile,
    selection,
    cosmetics: {
      paint: cosmetic(envelope.cosmetics['profile.paint']),
      wheelStyle: cosmetic(envelope.cosmetics['profile.wheelStyle']),
      livery: cosmetic(envelope.cosmetics['profile.livery']),
    },
    settings: {
      masterVolume: numberSetting(settings['experience.masterVolume'], DEFAULT_SETTINGS.masterVolume, 0, 1),
      musicVolume: numberSetting(settings['experience.musicVolume'], DEFAULT_SETTINGS.musicVolume, 0, 1),
      sfxVolume: numberSetting(settings['experience.sfxVolume'], DEFAULT_SETTINGS.sfxVolume, 0, 1),
      // Added with the engine sound rework: saves from before it have no value and get the default.
      engineVolume: numberSetting(settings['experience.engineVolume'], DEFAULT_SETTINGS.engineVolume, 0, 1),
      muted: booleanSetting(settings['experience.muted'], DEFAULT_SETTINGS.muted),
      reducedMotion: booleanSetting(settings['experience.reducedMotion'], DEFAULT_SETTINGS.reducedMotion),
      cameraFovDeg: numberSetting(settings['experience.cameraFovDeg'], DEFAULT_SETTINGS.cameraFovDeg, 50, 75),
      cameraShakeEnabled: booleanSetting(settings['experience.cameraShakeEnabled'], DEFAULT_SETTINGS.cameraShakeEnabled),
      uiScale: numberSetting(settings['experience.uiScale'], DEFAULT_SETTINGS.uiScale, 0.75, 1.5),
      ghostVisible: booleanSetting(settings['experience.ghostVisible'], DEFAULT_SETTINGS.ghostVisible),
      keyboardBindings,
      gamepadBindings,
      tutorialCompleted,
      tutorialSkipped,
      // Unknown or missing values fall back to the default instead of rejecting the whole profile.
      // Version 1 saves migrate once: a stored 'high' was the old default, so it moves to the new default.
      assistLevel: migrateAssistLevel(settings['experience.assistLevel'], settings['experience.assistVersion']),
      assistHintSeen: settings['experience.assistHintSeen'] === true,
      assistVersion: ASSIST_SETTINGS_VERSION,
    },
  };
  return record;
}

function validateRecord(record: ProfileRecord): void {
  if (!record.selection || !carIds.includes(record.selection.car) || !routeIds.includes(record.selection.route) ||
      !tunes.includes(record.selection.tune) || !lightings.includes(record.selection.lighting) || !qualities.includes(record.selection.quality)) {
    throw new SaveValidationError('incompatible', 'Profile selection contains unsupported content');
  }
  const customTune = (record.selection as ProfileSelection & { readonly customTune?: VehicleTune }).customTune;
  if (customTune) checkedCustomTune(customTune);
  const settings = record.settings;
  if (settings) validateBindingPair(settings.keyboardBindings ?? '', settings.gamepadBindings ?? '');
  if (settings && (!between(settings.masterVolume, 0, 1) || !between(settings.musicVolume, 0, 1) ||
      !between(settings.sfxVolume, 0, 1) || !between(settings.uiScale, 0.75, 1.5) ||
      settings.engineVolume !== undefined && !between(settings.engineVolume, 0, 1) ||
      typeof settings.muted !== 'boolean' || typeof settings.reducedMotion !== 'boolean' || typeof settings.ghostVisible !== 'boolean' ||
      settings.cameraFovDeg !== undefined && !between(settings.cameraFovDeg, 50, 75) ||
      settings.cameraShakeEnabled !== undefined && typeof settings.cameraShakeEnabled !== 'boolean' ||
      settings.tutorialCompleted !== undefined && typeof settings.tutorialCompleted !== 'boolean' ||
      settings.tutorialSkipped !== undefined && typeof settings.tutorialSkipped !== 'boolean' ||
      settings.assistLevel !== undefined && !isAssistLevel(settings.assistLevel) ||
      settings.assistHintSeen !== undefined && typeof settings.assistHintSeen !== 'boolean' ||
      settings.assistVersion !== undefined && !Number.isInteger(settings.assistVersion) ||
      settings.keyboardBindings !== undefined && settings.keyboardBindings.length > 2048 ||
      settings.gamepadBindings !== undefined && settings.gamepadBindings.length > 2048)) {
    throw new SaveValidationError('incompatible', 'Profile settings are invalid');
  }
  for (const value of Object.values(record.cosmetics ?? {})) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 256)) throw new SaveValidationError('incompatible', 'Profile cosmetics are invalid');
  }
}

function decodeCustomTune(settings: SaveEnvelope['settings'], car: ProfileSelection['car'], preset: TunePresetId): VehicleTune | undefined {
  const names = ['id', 'frontMuScale', 'rearMuScale', 'springScale', 'steeringScale', 'engineScale', 'handbrakeRearMuScale', 'rearDiffLock', 'frontBrakeBias'] as const;
  const present = names.filter(name => settings[`profile.customTune.${name}`] !== undefined);
  if (present.length === 0) return undefined;
  if (names.slice(0, 7).some(name => settings[`profile.customTune.${name}`] === undefined)) throw new SaveValidationError('incompatible', 'Saved custom tune is incomplete');
  const id = settings['profile.customTune.id'];
  if (typeof id !== 'string') throw new SaveValidationError('incompatible', 'Saved custom tune identity is invalid');
  const base = VEHICLE_TUNES[car]?.[preset];
  if (!base) throw new SaveValidationError('incompatible', 'Saved custom tune base preset is unavailable');
  const values: Record<string, string | number | boolean> = {};
  for (const name of names.slice(1)) {
    const saved = settings[`profile.customTune.${name}`];
    if (saved !== undefined) { values[name] = saved; continue; }
    const defaultValue = name === 'rearDiffLock' ? base.rearDiffLock : name === 'frontBrakeBias' ? base.frontBrakeBias : undefined;
    if (defaultValue === undefined) throw new SaveValidationError('incompatible', 'Saved custom tune base preset is missing new handling defaults');
    values[name] = defaultValue;
  }
  return checkedCustomTune({ id, ...values } as unknown as VehicleTune);
}

function checkedCustomTune(value: VehicleTune): VehicleTune {
  try { return validateVehicleTune(value); }
  catch (error) { throw new SaveValidationError('incompatible', error instanceof Error ? `Custom tune is invalid: ${error.message}` : 'Custom tune is invalid'); }
}

function stringSetting(value: unknown, kind: 'keyboard' | 'gamepad'): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2048) throw new SaveValidationError('incompatible', `${kind} binding data exceeds its limit`);
  return value;
}

function validateBindingPair(keyboard: string, gamepad: string): void {
  if (keyboard.length > 2048 || gamepad.length > 2048) throw new SaveValidationError('incompatible', 'Input bindings exceed 2048 characters');
  if (!keyboard && !gamepad) return;
  const result = validateBindings(keyboard || DEFAULT_KEYBOARD_BINDINGS, gamepad || DEFAULT_GAMEPAD_BINDINGS);
  if (!result.valid) throw new SaveValidationError('incompatible', result.errors.slice(0, 4).join('; '));
}

function cloneRecord(record: ProfileRecord): ProfileRecord {
  return { ...record, selection: { ...record.selection }, cosmetics: record.cosmetics && { ...record.cosmetics }, settings: record.settings && { ...record.settings } };
}
function enumSetting<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T;
  throw new SaveValidationError('incompatible', `Saved ${label} is unsupported`);
}
function numberSetting(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
  throw new SaveValidationError('incompatible', 'Saved experience setting is invalid');
}
function booleanSetting(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw new SaveValidationError('incompatible', 'Saved experience setting is invalid');
}
function cosmetic(value: string | undefined): string | undefined { return value; }
function between(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function assertProfile(profile: OwnerProfile): void { if (!profiles.includes(profile)) throw new Error('Unknown save profile'); }

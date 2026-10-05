/** Typed interface seed only. No game, profile store or diagnostics implementation supplied. */
import type { CarId, RouteId, LightingPreset, QualitySelection, PlatformTarget } from './runtime-contracts';
export type OwnerProfile = 'career' | 'sandbox';
export interface CandidateIdentity {
  readonly version: string;
  readonly buildId: string;
  readonly commit: string;
  readonly contentHash: string;
  readonly target: PlatformTarget;
}
export interface OwnerSelection {
  readonly car: CarId;
  readonly route: RouteId;
  readonly eventId: string | null;
  readonly lighting: LightingPreset;
  readonly quality: QualitySelection;
}
export interface OwnerReviewService {
  readonly identity: CandidateIdentity;
  getProfile(): OwnerProfile;
  switchProfile(profile: OwnerProfile): Promise<void>;
  listAvailableContent(): Readonly<Record<string, readonly string[]>>;
  select(selection: OwnerSelection): Promise<void>;
  resetVehicle(): void;
  restoreFactoryTune(): void;
  exportSave(): Promise<Blob>;
  /** Validate size/schema first; never evaluate imported data or overwrite without consent. */
  previewImport(file: Blob): Promise<{ compatible: boolean; warning: string | null }>;
  importSave(file: Blob, overwriteConfirmed: boolean): Promise<void>;
  exportBugReport(userDescription: string): Promise<Blob>;
}
/** Allowlisted player settings only; binding JSON is validated and bounded to 2 KiB each. */
export interface LocalBugReportSettings {
  readonly masterVolume: number;
  readonly musicVolume: number;
  readonly sfxVolume: number;
  readonly muted: boolean;
  readonly reducedMotion: boolean;
  /** Optional for older schema-1 reports; new reports include implemented preferences. */
  readonly cameraFovDeg?: number; // base vertical FOV, finite and in [50, 75]
  readonly cameraShakeEnabled?: boolean;
  readonly uiScale: number;
  readonly ghostVisible: boolean;
  readonly keyboardBindings: string;
  readonly gamepadBindings: string;
}
export interface LocalBugReport {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly identity: CandidateIdentity;
  readonly profile: OwnerProfile;
  readonly selection: OwnerSelection;
  readonly settings: LocalBugReportSettings;
  readonly timestamp: string;
  readonly reproductionSteps: readonly string[];
  readonly expected: string;
  readonly observed: string;
  readonly sanitizedDiagnostics: readonly string[];
  readonly automaticUpload: false;
}
export interface OwnerApproval {
  readonly status: 'NOT_REQUESTED' | 'CHANGES_REQUESTED' | 'APPROVED';
  readonly approvedBuildId: string | null;
  readonly approvedArtifactSha256: string | null;
  readonly actualHumanDecisionReference: string | null;
  readonly publicationSeparatelyAuthorized: boolean;
}

import type { CarId, Quat, Vec3 } from '../../contracts/runtime-contracts';

export type TunePresetId = 'Grip' | 'Balanced' | 'Drift';
export type TuneIdentityId = TunePresetId | 'Custom';
export interface EngineConfig {
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly torqueCurve: readonly Readonly<{ rpm: number; torqueNm: number }>[];
  readonly gearRatios: readonly number[];
  readonly finalDrive: number;
}
export interface VehicleConfig {
  readonly carId: CarId;
  readonly massKg: number;
  readonly wheelbaseM: number;
  readonly trackM: number;
  readonly centerOfMassM: Vec3;
  readonly wheelRadiusM: number;
  readonly engine: EngineConfig;
  readonly suspension: Readonly<{ restLengthM: number; travelM: number; springNPerM: number; damperNsPerM: number; maxForceN: number }>;
  readonly tires: Readonly<{ frontMu: number; rearMu: number; peakSlipAngleRad: number; postPeakGripFactor: number; lowSpeedRegularizationMS: number }>;
  readonly steering: Readonly<{ maxAngleLowSpeedRad: number; maxAngleHighSpeedRad: number; highSpeedMS: number; responseSeconds: number }>;
  readonly assists: Readonly<{ countersteerStrength: number; stabilityStrength: number }>;
  /**
   * Optional aerodynamics. downforceNPerMS2 * forwardSpeed^2 (capped at maxDownforceN) is added to tyre grip load,
   * split frontShare / (1 - frontShare) between the axles; ride height is unchanged. dragAreaM2 replaces the default
   * drag area (0.72 m^2). Cars without it behave exactly as before.
   */
  readonly aero?: Readonly<{ downforceNPerMS2: number; maxDownforceN: number; frontShare: number; dragAreaM2?: number }>;
  /** Optional drivetrain split. frontDriveShare (0..1) of engine torque goes to the front axle; omitted means rear drive. */
  readonly drivetrain?: Readonly<{ frontDriveShare: number }>;
}
export interface VehicleTune {
  readonly id: TuneIdentityId;
  readonly frontMuScale: number;
  readonly rearMuScale: number;
  readonly springScale: number;
  readonly steeringScale: number;
  readonly engineScale: number;
  readonly handbrakeRearMuScale: number;
  /** Bounded limited-slip torque transfer fraction; omitted on pre-v2 saved tunes. */
  readonly rearDiffLock?: number;
  /** Front axle share of service brake torque; omitted on pre-v2 saved tunes. */
  readonly frontBrakeBias?: number;
}
export interface VehicleSimulationOptions {
  readonly gravity?: Vec3;
  readonly ground?: GroundConfig | false;
  readonly carId?: CarId;
  readonly tune?: TunePresetId;
  readonly spawn?: Readonly<{ position?: Vec3; rotation?: Quat; linearVelocityMS?: Vec3 }>;
}
export interface GroundConfig {
  readonly heightM?: number;
  readonly halfExtentsM?: Vec3;
  readonly friction?: number;
  readonly restitution?: number;
  readonly surfaceId?: string;
}
export type ColliderCategory = 'ground' | 'wall' | 'prop';
export interface BoxColliderOptions {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  readonly rotation?: Quat;
  readonly friction?: number;
  readonly restitution?: number;
  readonly surfaceId?: string;
  readonly category?: ColliderCategory;
}
export interface ColliderHandle { readonly handle: number; }
export interface CollisionTelemetry {
  readonly tick: number;
  readonly impact: boolean;
  readonly impulseNs: number;
  readonly speedDeltaMS: number;
  readonly colliderIds: readonly string[];
}
/** Detailed fixed-step tire data for diagnostics and deterministic handling fixtures. */
export interface WheelDynamicsTelemetry {
  readonly contact: boolean;
  readonly surfaceId: string | null;
  readonly contactPoint: Vec3 | null;
  readonly surfaceNormal: Vec3 | null;
  readonly normalLoadN: number;
  readonly longitudinalVelocityMS: number;
  readonly lateralVelocityMS: number;
  readonly angularVelocityRadS: number;
  readonly slipRatio: number;
  readonly slipAngleRad: number;
  readonly handbrakeGripScale: number;
  readonly frictionCapacityN: number;
  /** Longitudinal tire-force demand before combined-friction allocation; locked wheels use the zero-spin contact demand. */
  readonly longitudinalForceDemandN: number;
  readonly rawLongitudinalForceN: number;
  readonly rawLateralForceN: number;
  readonly appliedLongitudinalForceN: number;
  readonly appliedLateralForceN: number;
  readonly driveTorqueNm: number;
  readonly availableBrakeTorqueNm: number;
  readonly brakeLockActive: boolean;
  readonly brakeLockRequiredTorqueNm: number;
  readonly brakeLockForceN: number;
}
export interface VehicleDynamicsTelemetry {
  readonly simulationTick: number;
  readonly wheels: readonly [WheelDynamicsTelemetry, WheelDynamicsTelemetry, WheelDynamicsTelemetry, WheelDynamicsTelemetry];
}
export interface InterpolatedSnapshots {
  readonly previous: import('../../contracts/runtime-contracts').VehicleSnapshot;
  readonly current: import('../../contracts/runtime-contracts').VehicleSnapshot;
  readonly interpolationAlpha: number;
}

export { createVehicleSimulation } from './vehicle-simulation';
export type { VehicleSimulationHandle } from './vehicle-simulation';
export type {
  BoxColliderOptions,
  ColliderCategory,
  ColliderHandle,
  CollisionTelemetry,
  GroundConfig,
  InterpolatedSnapshots,
  TunePresetId,
  TuneIdentityId,
  VehicleDynamicsTelemetry,
  VehicleConfig,
  VehicleSimulationOptions,
  VehicleTune,
  WheelDynamicsTelemetry,
} from '../vehicle/types';
export { VEHICLE_CONFIGS, TUNING_PRESETS, VEHICLE_TUNES } from '../vehicle/configs';
export { createVehicleTuneIdentity, validateVehicleTune, VEHICLE_PHYSICS_VERSION } from '../vehicle/tune-identity';
export { ASSIST_BADGES, ASSIST_LABELS, ASSIST_LEVELS, ASSIST_PROFILES, ASSIST_SETTINGS_VERSION, DEFAULT_PLAYER_ASSIST, assistProfile, isAssistLevel, migrateAssistLevel } from './assists';
export type { AssistLevel, AssistProfile, AssistTelemetry } from './assists';

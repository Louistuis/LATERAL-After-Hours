import type { CarId } from '../../contracts/runtime-contracts';
import type { TunePresetId, VehicleConfig, VehicleTune } from './types';

const engine = (power: number) => ({
  idleRpm: 850, redlineRpm: 7600,
  torqueCurve: [
    { rpm: 850, torqueNm: 130 * power }, { rpm: 2500, torqueNm: 242 * power },
    { rpm: 4500, torqueNm: 292 * power }, { rpm: 6500, torqueNm: 270 * power },
    { rpm: 7600, torqueNm: 220 * power },
  ],
  gearRatios: [3.45, 2.18, 1.55, 1.2, 0.96, 0.79], finalDrive: 4.05,
});

export const VEHICLE_CONFIGS: Readonly<Record<CarId, VehicleConfig>> = {
  'CAR-01': {
    carId: 'CAR-01', massKg: 1160, wheelbaseM: 2.42, trackM: 1.34,
    centerOfMassM: { x: 0, y: -0.2, z: 0 }, wheelRadiusM: 0.33, engine: engine(1.3),
    suspension: { restLengthM: 0.32, travelM: 0.18, springNPerM: 32000, damperNsPerM: 3400, maxForceN: 18000 },
    tires: { frontMu: 1.13, rearMu: 1.05, peakSlipAngleRad: 0.14, postPeakGripFactor: 0.74, lowSpeedRegularizationMS: 0.5 },
    steering: { maxAngleLowSpeedRad: 0.72, maxAngleHighSpeedRad: 0.32, highSpeedMS: 35, responseSeconds: 0.12 },
    assists: { countersteerStrength: 0.12, stabilityStrength: 0.035 },
  },
  'CAR-02': {
    carId: 'CAR-02', massKg: 1380, wheelbaseM: 2.61, trackM: 1.25,
    centerOfMassM: { x: 0, y: -0.24, z: -0.035 }, wheelRadiusM: 0.33, engine: engine(1.55),
    suspension: { restLengthM: 0.34, travelM: 0.18, springNPerM: 35000, damperNsPerM: 3750, maxForceN: 20000 },
    tires: { frontMu: 1.11, rearMu: 1.01, peakSlipAngleRad: 0.145, postPeakGripFactor: 0.7, lowSpeedRegularizationMS: 0.55 },
    steering: { maxAngleLowSpeedRad: 0.76, maxAngleHighSpeedRad: 0.34, highSpeedMS: 38, responseSeconds: 0.11 },
    assists: { countersteerStrength: 0.14, stabilityStrength: 0.04 },
  },
  // McLaren Formula 1 (halo car): light, brutal and planted. Huge mechanical grip, downforce that grows with speed (it
  // fades when the car is sideways, so slides stay possible), very quick steering. Torque is geared so it still breaks
  // the rear loose on power or handbrake. Dimensions match public/assets/cars/mclaren-f1.glb (anchors at y=-0.36).
  'CAR-04': {
    carId: 'CAR-04', massKg: 760, wheelbaseM: 3.226, trackM: 1.795,
    centerOfMassM: { x: 0, y: -0.28, z: 0.05 }, wheelRadiusM: 0.33,
    engine: {
      idleRpm: 850, redlineRpm: 7600,
      torqueCurve: [
        { rpm: 850, torqueNm: 500 }, { rpm: 2500, torqueNm: 700 }, { rpm: 4500, torqueNm: 900 }, { rpm: 6500, torqueNm: 1000 }, { rpm: 7600, torqueNm: 960 },
      ],
      // Long top gear: about 370 km/h where power meets drag, 378 km/h at the limiter.
      gearRatios: [3.0, 2.2, 1.72, 1.4, 1.17, 1.0], finalDrive: 2.45,
    },
    suspension: { restLengthM: 0.285, travelM: 0.12, springNPerM: 40000, damperNsPerM: 3600, maxForceN: 16000 },
    tires: { frontMu: 1.72, rearMu: 1.95, peakSlipAngleRad: 0.11, postPeakGripFactor: 0.66, lowSpeedRegularizationMS: 0.5 },
    steering: { maxAngleLowSpeedRad: 0.7, maxAngleHighSpeedRad: 0.26, highSpeedMS: 45, responseSeconds: 0.06 },
    assists: { countersteerStrength: 0.1, stabilityStrength: 0.05 },
    aero: { downforceNPerMS2: 2.4, maxDownforceN: 15000, frontShare: 0.42, dragAreaM2: 0.75 },
  },
  // Lancia Delta (rally): light, short and four wheel drive with a rear bias, so it pulls out of slides on power. Soft
  // long-travel springs, quick steering and a gentle breakaway make it the easy, drift-happy touge car. Mid-pack pace:
  // short rally gearing gives it a strong launch and a modest top speed. Dimensions match public/assets/cars/lancia-delta.glb.
  'CAR-05': {
    carId: 'CAR-05', massKg: 1150, wheelbaseM: 2.455, trackM: 1.43,
    centerOfMassM: { x: 0, y: -0.22, z: -0.02 }, wheelRadiusM: 0.32,
    engine: { ...engine(1.25), finalDrive: 4.4 },
    suspension: { restLengthM: 0.33, travelM: 0.2, springNPerM: 30000, damperNsPerM: 3200, maxForceN: 18000 },
    tires: { frontMu: 1.24, rearMu: 1.1, peakSlipAngleRad: 0.15, postPeakGripFactor: 0.78, lowSpeedRegularizationMS: 0.5 },
    steering: { maxAngleLowSpeedRad: 0.78, maxAngleHighSpeedRad: 0.34, highSpeedMS: 32, responseSeconds: 0.09 },
    assists: { countersteerStrength: 0.14, stabilityStrength: 0.035 },
    drivetrain: { frontDriveShare: 0.25 },
  },
  // Koenigsegg Agera (halo car): heavier than the McLaren with a mid-engine rear weight bias and slightly less grip and
  // downforce, but far more power and a long top gear for about 400 km/h. The rear lets go sooner and more sharply than
  // the McLaren's, so it rewards a careful right foot. Dimensions match public/assets/cars/agera.glb.
  'CAR-06': {
    carId: 'CAR-06', massKg: 1435, wheelbaseM: 2.666, trackM: 1.72,
    centerOfMassM: { x: 0, y: -0.26, z: 0.09 }, wheelRadiusM: 0.335,
    engine: {
      idleRpm: 900, redlineRpm: 8000,
      torqueCurve: [
        { rpm: 900, torqueNm: 600 }, { rpm: 2500, torqueNm: 950 }, { rpm: 4500, torqueNm: 1200 }, { rpm: 6500, torqueNm: 1300 }, { rpm: 8000, torqueNm: 1150 },
      ],
      // Long top gear: about 400 km/h where the limiter cuts in (drag alone would allow a little more).
      gearRatios: [3.1, 2.2, 1.65, 1.3, 1.05, 0.8], finalDrive: 3.0,
    },
    suspension: { restLengthM: 0.305, travelM: 0.12, springNPerM: 52000, damperNsPerM: 4800, maxForceN: 22000 },
    tires: { frontMu: 1.76, rearMu: 1.7, peakSlipAngleRad: 0.1, postPeakGripFactor: 0.62, lowSpeedRegularizationMS: 0.5 },
    steering: { maxAngleLowSpeedRad: 0.68, maxAngleHighSpeedRad: 0.25, highSpeedMS: 45, responseSeconds: 0.07 },
    assists: { countersteerStrength: 0.12, stabilityStrength: 0.05 },
    aero: { downforceNPerMS2: 2.0, maxDownforceN: 12000, frontShare: 0.45, dragAreaM2: 0.6 },
  },
};

export const TUNING_PRESETS: Readonly<Record<TunePresetId, VehicleTune>> = {
  Grip: { id: 'Grip', frontMuScale: 1.13, rearMuScale: 1.15, springScale: 1.08, steeringScale: 0.92, engineScale: 0.95, handbrakeRearMuScale: 0.34, rearDiffLock: 0, frontBrakeBias: 0.5 },
  Balanced: { id: 'Balanced', frontMuScale: 1, rearMuScale: 1, springScale: 1, steeringScale: 1, engineScale: 1, handbrakeRearMuScale: 0.28, rearDiffLock: 0, frontBrakeBias: 0.5 },
  Drift: { id: 'Drift', frontMuScale: 1.08, rearMuScale: 0.82, springScale: 0.94, steeringScale: 1.13, engineScale: 1.08, handbrakeRearMuScale: 0.2, rearDiffLock: 0, frontBrakeBias: 0.5 },
};

/** Car-specific calibrations preserve each preset's intent against each engine/mass class. */
export const VEHICLE_TUNES: Readonly<Record<CarId, Readonly<Record<TunePresetId, VehicleTune>>>> = {
  // Muscle car: rear-drive with torque to spare, so even the default Balanced tune lets the tail step out on throttle.
  'CAR-01': {
    ...TUNING_PRESETS,
    Balanced: { id: 'Balanced', frontMuScale: 1, rearMuScale: 0.93, springScale: 1, steeringScale: 1.02, engineScale: 1, handbrakeRearMuScale: 0.26, rearDiffLock: 0, frontBrakeBias: 0.5 },
  },
  'CAR-02': {
    ...TUNING_PRESETS,
    // Heavy truck: more rear-grip headroom than the Challenger, so it needs more throttle/handbrake to rotate, but its big torque holds the slide once started.
    Drift: { id: 'Drift', frontMuScale: 1.1, rearMuScale: 0.9, springScale: 0.96, steeringScale: 1.1, engineScale: 1.05, handbrakeRearMuScale: 0.24, rearDiffLock: 0, frontBrakeBias: 0.5 },
  },
  'CAR-04': {
    ...TUNING_PRESETS,
    // Monster grip and torque: Drift loosens the rear less than on the road cars, or full throttle just spins it.
    Drift: { id: 'Drift', frontMuScale: 1.06, rearMuScale: 0.8, springScale: 0.95, steeringScale: 1.08, engineScale: 1, handbrakeRearMuScale: 0.18, rearDiffLock: 0, frontBrakeBias: 0.5 },
  },
  'CAR-05': {
    ...TUNING_PRESETS,
    // Rally car: Balanced already lets the tail swing on a lift or a flick; Drift loosens it a touch more and frees the handbrake.
    Balanced: { id: 'Balanced', frontMuScale: 1, rearMuScale: 0.97, springScale: 1, steeringScale: 1.03, engineScale: 1, handbrakeRearMuScale: 0.25, rearDiffLock: 0.15, frontBrakeBias: 0.55 },
    Drift: { id: 'Drift', frontMuScale: 1.08, rearMuScale: 0.84, springScale: 0.94, steeringScale: 1.12, engineScale: 1.05, handbrakeRearMuScale: 0.2, rearDiffLock: 0.15, frontBrakeBias: 0.5 },
  },
  'CAR-06': {
    ...TUNING_PRESETS,
    // A little less rear grip than the McLaren's Balanced, so a lift or a handbrake flick rotates it more readily.
    Balanced: { id: 'Balanced', frontMuScale: 1, rearMuScale: 0.97, springScale: 1, steeringScale: 1, engineScale: 1, handbrakeRearMuScale: 0.22, rearDiffLock: 0, frontBrakeBias: 0.5 },
    // Huge torque on a grippy rear: like the McLaren, Drift loosens the rear less than on the road cars or full throttle just spins it.
    Drift: { id: 'Drift', frontMuScale: 1.06, rearMuScale: 0.82, springScale: 0.95, steeringScale: 1.08, engineScale: 1, handbrakeRearMuScale: 0.18, rearDiffLock: 0, frontBrakeBias: 0.5 },
  },
};

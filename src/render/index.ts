export { applySceneMaterialProfile, setWetSurfaceQuality } from './material-profile';
export type { MaterialProfileReport } from './material-profile';
export { createAutoQualityController, MIN_RESOLUTION_SCALE, QUALITY_TIERS } from './auto-quality';
export type { AutoQualityController, AutoQualityControllerOptions } from './auto-quality';
export { initialQualityForGpu, classifyGpu, readGpuRenderer } from './gpu-tier';
export type { GpuClass } from './gpu-tier';
export {
  applyCarPaint, applyPaintToMaterial, CAR_PAINT_FINISHES, getCarPaint, listCarPaints, paintFromSwatch, registerCarPaint, setCarPaintQuality,
} from './car-paint';
export type { CarPaintFinish, CarPaintPreset } from './car-paint';
export { createShadowBudgetPolicy } from './shadow-budget';
export type { ShadowBudgetPolicy } from './shadow-budget';
export { createRenderPassCensus } from './pass-census';
export type { RenderCensusBucket, RenderCensusCategories, RenderCensusCategory, RenderCensusPass, RenderCensusRoots, RenderPassCensus, RenderPassCensusFrame } from './pass-census';
export { createCameraMotionBlurPrototype, reprojectPreviousUv } from './camera-motion-blur';
export type { CameraMotionBlurPrototype, CameraMotionBlurStats, CameraMotionBlurStatus } from './camera-motion-blur';
export { createPostFx } from './post-fx';
export type { PostFx, PostFxStats, PostGrade, PostScatterInput } from './post-fx';

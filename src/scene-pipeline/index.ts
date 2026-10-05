import type { ScenePipelineOptions } from './composition';
import { createScenePipelineWithAssets } from './composition';
import { loadCarModel, loadHeroWorld } from '../world';

export { createScenePipelineWithAssets } from './composition';
export type {
  ScenePipeline, ScenePipelineOptions, SceneRenderStats, ScenePipelineStats, SceneCosmetics,
  SceneCosmeticsCatalog, WorldPresentation, CarPresentation, SceneAssetFactory,
} from './composition';

/** Boot the authored world and car from locally bundled runtime assets. */
export function createScenePipeline(canvas: HTMLCanvasElement, options: ScenePipelineOptions = {}) {
  return createScenePipelineWithAssets(canvas, { loadHeroWorld, loadCarModel }, options);
}

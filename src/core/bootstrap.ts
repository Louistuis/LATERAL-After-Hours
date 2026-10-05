import { createScenePipeline, type ScenePipeline } from '../scene-pipeline';
import { STARTER_CAR } from '../vehicle/starter-car';
import { createPlayerInput, type PlayerInput } from '../input';
import { createExperienceServices, createExperienceShell, type ExperienceServices, type ExperienceShell } from '../experience';
import { GameRuntime } from './game-runtime';
import { createBootShell } from './boot-shell';
import { attachCanvasRecovery } from './canvas-recovery';
import { SaveValidationError } from '../save/envelope';
import { detectDeviceProfile } from '../platform/device-profile';
import { watchViewport } from '../platform/viewport';

/** The one browser entry: real world → physics → input → persistent player experience. */
export async function bootstrap(root: HTMLElement, signal?: AbortSignal): Promise<() => void> {
  const boot = createBootShell(root);
  let scene: ScenePipeline | undefined;
  let runtime: GameRuntime | undefined;
  let input: PlayerInput | undefined;
  let services: ExperienceServices | undefined;
  let experience: ExperienceShell | undefined;
  let detachRecovery: (() => void) | undefined;
  let detachViewport: (() => void) | undefined;
  let detachObservations: (() => void) | undefined;
  let firstPlayableAtMs: number | null = null;
  let disposed = false;
  const checkCurrent = () => { if(signal?.aborted||boot.canvas.parentElement!==root)throw new DOMException('Boot replaced','AbortError'); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    detachViewport?.(); detachRecovery?.(); detachObservations?.(); experience?.dispose();
    void services?.dispose().catch(error => console.error('Save flush failed', error));
    if (runtime) runtime.dispose(); else scene?.dispose();
    input?.dispose();
  };
  try {
    boot.progress('Opening Harbor Works…');
    // Phones start on Low, tablets and desktops on Balanced; the saved profile choice replaces it once loaded.
    scene = await createScenePipeline(boot.canvas, { quality: detectDeviceProfile().defaultQuality, lighting: 'golden-hour', carId: STARTER_CAR });
    checkCurrent();
    // Shader programs link in the background while physics and the save load; the first frame then skips
    // several seconds of synchronous compiles on integrated GPUs.
    const shadersReady = scene.precompile?.().catch(() => undefined);
    boot.progress('Getting the car ready…');
    input = createPlayerInput(boot.canvas);
    runtime = await GameRuntime.create(scene, input);
    // Everyone starts in the starter car (the scene above already holds its model); premium cars are bought in the shop.
    await runtime.selectCar(STARTER_CAR);
    checkCurrent();
    if (__OWNER_REVIEW__) {
      const observedRuntime = runtime;
      const setQuality = (preset: string) => {
        if (preset !== 'low' && preset !== 'balanced' && preset !== 'high' && preset !== 'ultra') throw new Error('Unknown graphics preset');
        observedRuntime.setQuality(preset);
      };
      const liveBench = Object.freeze({
        version: 1,
        identity: __BUILD__,
        /** Relative to this document's performance time origin; bytes are measured externally. */
        get firstPlayableAtMs() { return firstPlayableAtMs; },
        get tick() { return observedRuntime.view().frame.current.simulationTick; },
        get paused() { return observedRuntime.view().paused; },
        get quality() { return observedRuntime.scene.lastStats?.quality; },
        get stats() { return structuredClone(observedRuntime.scene.lastStats); },
        get contextState() { return observedRuntime.scene.currentContextState; },
        get passCensus() { return structuredClone(observedRuntime.scene.lastPassCensus ?? null); },
        requestPassCensus() {
          if (!observedRuntime.scene.requestPassCensus) throw new Error('Render pass census is unavailable');
          observedRuntime.scene.requestPassCensus();
        },
        get metrics() { return observedRuntime.metrics.summary(); },
        get intervals() { return observedRuntime.metrics.samples(); },
        setQuality,
      });
      const benchObservation = () => liveBench;
      const qaObservation = () => structuredClone({
        identity: __BUILD__, view: observedRuntime.view(),
      });
      Object.defineProperty(window,'__LATERAL_BENCH__',{configurable:true,get:benchObservation});
      Object.defineProperty(window,'__LATERAL_QA__',{configurable:true,get:qaObservation});
      detachObservations = () => {
        if(Object.getOwnPropertyDescriptor(window,'__LATERAL_BENCH__')?.get===benchObservation)Reflect.deleteProperty(window,'__LATERAL_BENCH__');
        if(Object.getOwnPropertyDescriptor(window,'__LATERAL_QA__')?.get===qaObservation)Reflect.deleteProperty(window,'__LATERAL_QA__');
      };
    }
    detachRecovery = attachCanvasRecovery(boot.canvas, runtime, state => boot.graphics(state));
    // Resize, rotation, URL-bar and DPR changes; the ratio is capped per device class (phone 1.5, tablet 2).
    const stage = scene;
    detachViewport = watchViewport(root, (width, height, ratio) => stage.resize(width, height, ratio));
    boot.progress('Opening your garage…');
    services = await createExperienceServices(runtime, __BUILD__.target);
    checkCurrent();
    // Validate before mounting an experience whose cleanup also owns input.
    // Recovery preserves the original bytes and waits for an explicit choice.
    const profiles = services.profiles;
    try { await profiles.load('career'); }
    catch (error) {
      if (!(error instanceof SaveValidationError)) throw error;
      checkCurrent();
      await boot.recoverSave(error, {
        exportBackup: () => profiles.exportRawBackup('career'),
        playForSession: () => profiles.startSessionOnlyRecovery('career', true),
      }, signal);
    }
    await shadersReady;
    checkCurrent();
    experience = await createExperienceShell(boot.overlay, runtime, { input, ...services });
    checkCurrent();
    boot.ready();
    if (__OWNER_REVIEW__) firstPlayableAtMs = performance.now();
    // The usable scene and experience are now uncovered. Transfer size is a
    // separately measured release metric; do not manufacture a zero-byte value.
    services.platform.handle({ type: 'first-playable', firstPlayableTransferBytes: null });
  } catch (error) {
    dispose();
    if(signal?.aborted||boot.canvas.parentElement!==root)boot.dispose();
    else {console.error('LATERAL could not start', error);boot.fail(error);}
  }
  return () => { dispose(); boot.dispose(); };
}

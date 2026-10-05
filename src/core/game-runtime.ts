import * as THREE from 'three';
import type { CarId, EventMode, FrameSnapshot, InputFrame, LightingPreset, PauseReason, QualityPreset, QualitySelection, Quat, RouteId, RunResult, Vec3, VehicleSnapshot } from '../../contracts/runtime-contracts';
import type { CollisionMeshData, RouteDefinition } from '../../contracts/world-contracts';
import { createVehicleSimulation, DEFAULT_PLAYER_ASSIST, VEHICLE_PHYSICS_VERSION, type AssistLevel, type VehicleSimulationHandle, type TunePresetId, type VehicleTune } from '../physics';
import { DrivingSession } from '../driving';
import { RecoveryTracker } from '../driving/recovery';
import type { RecoveryState } from '../driving/session';
import { createRunController, createDriftScorer, medalTargetsFor, validMedalTargets, type MedalTargets, type RunStatus } from '../events';
import { interpolateGhost, type GhostTransform } from '../ghosts';
import { RouteProgressTracker } from './route-progress';
import { FrameMetrics } from './metrics';
import type { SceneCosmeticsCatalog } from '../scene-pipeline/ports';
import type { SceneRenderStats } from '../scene-pipeline/stage';
import { compatibilityId } from './compatibility-id';
import { createAutoQualityController } from '../render/auto-quality';
import { detectDeviceProfile } from '../platform/device-profile';
import { initialQualityForGpu } from '../render/gpu-tier';
import type { RenderPassCensusFrame } from '../render/pass-census';

/** Structural port keeps the root loop independent of renderer implementation details. */
/** Paused showcase frames render at about 30 fps (slightly under 1/30 s so 60 Hz vsync jitter never drops to 20). */
const SHOWCASE_FRAME_SECONDS=1/32;
export interface GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  /** Optional cached camera-ray candidates from designated environment meshes.
   * The scene owns their lifecycle; consumers still respect live visibility. */
  readonly cameraOccluders?: readonly THREE.Object3D[];
  readonly cosmeticsCatalog?:SceneCosmeticsCatalog;
  readonly lastStats?:SceneRenderStats;
  /** Live lifecycle state; lastStats describes the most recently rendered frame. */
  readonly currentContextState?:'ready'|'lost'|'failed';
  /** Explicit owner-review diagnostic for one ordinary render, never a timing sample. */
  readonly lastPassCensus?: RenderPassCensusFrame | null;
  requestPassCensus?(): void;
  readonly world: { readonly routes:readonly RouteDefinition[]; readonly collisionMeshes:readonly CollisionMeshData[]; readonly spawn:{readonly position:{x:number;y:number;z:number};readonly rotation:{x:number;y:number;z:number;w:number}} };
  render(frame:FrameSnapshot,dt:number,options?:{cameraManagedExternally?:boolean;brakePressed?:number;simulationActive?:boolean}):unknown;
  resize(width:number,height:number,pixelRatio?:number):void;
  resetCamera():void;
  setLighting(preset:LightingPreset):void;
  setQuality(preset:QualityPreset):void;
  /** Auto-quality dynamic resolution multiplier (0.6 to 1). */
  setResolutionScale?(scale:number):void;
  /** WebGL renderer string, used for Auto's starting tier. */
  readonly gpuRenderer?:string;
  setCar(carId:CarId):void|Promise<void>;
  setCosmetics(cosmetics:{paint?:string;wheelStyle?:string;livery?:string}):void;
  setRoute(routeId:RouteId):void;
  setGhost(snapshot:VehicleSnapshot|null):void;
  dispose():void;
}
export interface InputSource { read(tick:number):InputFrame; clear():void; }
export interface RuntimeView {
  readonly frame:FrameSnapshot;
  /** Last normalized controls consumed by simulation; neutral while paused or resetting. */
  readonly input:InputFrame;
  readonly route:RouteDefinition;
  readonly carId:CarId;
  readonly tune:TunePresetId;
  readonly mode:EventMode|'free-drive';
  readonly run:RunStatus|null;
  readonly result:RunResult|null;
  readonly paused:boolean;
  readonly presentation:'drive'|'replay'|'photo';
  readonly replayProgress:number;
  /** Latest crash recovery (count, reason, time penalty) for HUD feedback. */
  readonly recovery?:RecoveryState;
  readonly metrics:ReturnType<FrameMetrics['summary']>;
  /** Medal targets of the current event (null in free drive or when the route has none calibrated). */
  readonly medalTargets?:MedalTargets|null;
}
export interface EventSelection {
  readonly mode:EventMode;
  readonly medalTargets?:Readonly<{gold:number;silver:number;bronze:number}>;
  readonly rulesVersion:string;
}

export class GameRuntime {
  readonly simulation:VehicleSimulationHandle;
  readonly metrics=new FrameMetrics();
  readonly scene:GameScene;
  private session:DrivingSession;
  private route:RouteDefinition;
  private carId:CarId='CAR-01';
  private tune:TunePresetId='Balanced';
  private mode:RuntimeView['mode']='free-drive';
  private presentation:RuntimeView['presentation']='drive';
  private result:RunResult|null=null;
  private eventSelection:EventSelection|null=null;
  private measured=this.metrics.summary();
  private nextMetricsAt=0;
  private callbacks=new Set<(view:RuntimeView)=>void>();
  private onResult:((result:RunResult)=>void)|null=null;
  /** Most assisted level used during the current run (recorded on the result; leaderboards show it as a badge). */
  private runAssist:AssistLevel=DEFAULT_PLAYER_ASSIST;
  private medalTargets:MedalTargets|null=null;
  private assistLevel:AssistLevel=DEFAULT_PLAYER_ASSIST;
  private raf=0;
  private lastTime=0;
  private disposed=false;
  private lastBrake=0;
  private lastInput:InputFrame=neutralInput(0);
  private replay:readonly GhostTransform[]=[];
  private replayTime=0;
  /** Replay playback rate: 0 holds the frame (photo from a replay), 1 is real time. */
  private replaySpeed=1;
  private rival:readonly GhostTransform[]=[];
  private ghostVisible=true;
  private cameraUpdate:((frame:FrameSnapshot,dt:number,presentation:RuntimeView['presentation'],paused:boolean)=>void)|null=null;
  private cameraReset:(()=>void)|null=null;
  private input:InputSource;
  private detachVisibility:()=>void;
  private readonly roadSurfaces:Set<string>;
  private readonly edgeSurfaces:Set<string>;
  private renderFailure:((error:Error)=>void)|null=null;
  private carOperation=0;
  private readonly autoInitial:QualityPreset;
  private readonly autoQuality:ReturnType<typeof createAutoQualityController>;
  private appliedResolutionScale=1;
  private qualitySelection:QualitySelection='balanced';
  private gridOffset:{rightM:number;backM:number}|null=null;
  private effectiveQuality:QualityPreset='balanced';

  static async create(scene:GameScene,input:InputSource):Promise<GameRuntime> {
    if(!scene.world.routes.length)throw new Error('World has no authored driving route');
    const simulation=await createVehicleSimulation({ground:false,spawn:scene.world.spawn,assist:DEFAULT_PLAYER_ASSIST});
    try {
      for(const mesh of scene.world.collisionMeshes)simulation.addStaticTriangleMesh(mesh.vertices,mesh.indices,mesh.surfaceId,undefined,mesh.role??'surface');
      return new GameRuntime(scene,simulation,input);
    } catch(error) {simulation.dispose();throw error;}
  }
  private constructor(scene:GameScene,simulation:VehicleSimulationHandle,input:InputSource) {
    this.scene=scene;this.simulation=simulation;this.input=input;this.route=scene.world.routes[0];
    const autoTiers=initialQualityForGpu(detectDeviceProfile(),scene.gpuRenderer??'');
    this.autoInitial=autoTiers.initial;
    this.autoQuality=createAutoQualityController({initialPreset:autoTiers.initial,maxPreset:autoTiers.max});
    this.effectiveQuality=scene.lastStats?.quality??'balanced';this.qualitySelection=this.effectiveQuality;
    this.autoQuality.lockFixed(this.effectiveQuality);
    this.roadSurfaces=new Set(scene.world.collisionMeshes.filter(mesh=>mesh.drivableRoad===true&&mesh.role!=='obstacle').map(mesh=>mesh.surfaceId));
    // Curbs and the run-off shoulder beside them: legal to drive on (no off-road invalidation), not asphalt for scoring.
    this.edgeSurfaces=new Set(scene.world.collisionMeshes.filter(mesh=>mesh.role!=='obstacle'&&mesh.surfaceId.startsWith('curb:')).map(mesh=>mesh.surfaceId));
    this.session=new DrivingSession({simulation,recovery:this.makeRecovery(this.route)});
    const visibility=()=>{this.clearInput();if(document.hidden)this.pause('hidden');else this.resume('hidden');this.lastTime=performance.now();};
    document.addEventListener('visibilitychange',visibility);this.detachVisibility=()=>document.removeEventListener('visibilitychange',visibility);
    scene.setRoute(this.route.id);
  }
  start():void {if(this.raf||this.disposed)return;this.lastTime=performance.now();this.raf=requestAnimationFrame(this.frame);}
  subscribe(callback:(view:RuntimeView)=>void):()=>void {this.callbacks.add(callback);return ()=>this.callbacks.delete(callback);}
  onRunFinished(callback:(result:RunResult)=>void):void {this.onResult=callback;}
  onRenderFailure(callback:(error:Error)=>void):void {this.renderFailure=callback;}
  setCameraController(callback:GameRuntime['cameraUpdate'],reset?:()=>void):void {
    this.cameraUpdate=callback;this.cameraReset=callback&&reset?reset:null;
  }
  view():RuntimeView {return {frame:this.session.snapshot(),input:{...this.lastInput},route:this.route,carId:this.carId,tune:this.tune,mode:this.mode,run:this.session.run?.status()??null,result:this.result,medalTargets:this.medalTargets,paused:this.session.pauses.isPaused(),presentation:this.presentation,recovery:this.session.recoveryState(),replayProgress:this.replay.length>1?(this.replayTime-this.replay[0].timeSeconds)/(this.replay.at(-1)!.timeSeconds-this.replay[0].timeSeconds):0,metrics:this.measured};}
  routes():readonly RouteDefinition[] {return this.scene.world.routes;}
  pause(reason:PauseReason):void {this.session.pauses.add(reason);this.clearInput();}
  resume(reason:PauseReason):void {this.session.pauses.remove(reason);this.clearInput();this.lastTime=performance.now();}
  selectRoute(id:RouteId):void {
    const route=this.routes().find(route=>route.id===id);if(!route)throw new Error(`Unknown route ${id}`);
    // Validate/render first, so a rejected unloaded route cannot move authoritative physics.
    this.scene.setRoute(id);this.route=route;this.simulation.setSpawn(route.spawn.position,route.spawn.rotation);this.freeDrive();
  }
  async selectCar(id:CarId):Promise<void> {
    const operation=++this.carOperation;
    const alreadyPaused=this.session.pauses.reasons().has('menu');this.pause('menu');
    try {
      await this.scene.setCar(id);if(this.disposed||operation!==this.carOperation)return;
      this.simulation.setCar(id);this.carId=id;
      this.simulation.setSpawn(this.route.spawn.position,this.route.spawn.rotation);this.freeDrive();
    } catch(error) {
      if(!this.disposed&&operation===this.carOperation&&!alreadyPaused)this.resume('menu');
      throw error;
    }
  }
  /** Driving assists act inside the fixed-step sim from the next step on; a run keeps the most assisted level used. */
  setAssist(level:AssistLevel):void {
    this.assistLevel=level;this.simulation.setAssist?.(level);
    const rank={off:0,medium:1,high:2} as const;
    if(this.mode!=='free-drive'&&rank[level]>rank[this.runAssist])this.runAssist=level;
  }
  assist():AssistLevel {return this.assistLevel;}
  selectTune(preset:TunePresetId):void {this.simulation.setTune(preset);this.tune=preset;this.freeDrive();}
  tuning():VehicleTune {return this.simulation.getTuning();}
  selectCustomTune(tune:VehicleTune):void {this.simulation.setTune({...tune,id:'Custom'});this.freeDrive();}
  restoreFactoryTune():void {this.selectTune(this.tune);}
  freeDrive():void {
    const reasons=this.session.pauses.reasons();this.session=new DrivingSession({simulation:this.simulation,recovery:this.makeRecovery(this.route)});
    for(const reason of reasons)if(reason!=='menu'&&reason!=='manual')this.session.pauses.add(reason);
    this.mode='free-drive';this.result=null;this.eventSelection=null;this.medalTargets=null;this.presentation='drive';this.replay=[];this.rival=[];this.scene.setGhost(null);this.clearInput();this.resetCameraHistory();
    if(document.hidden)this.pause('hidden');
  }
  beginEvent(selection:EventSelection):void {
    const reasons=this.session.pauses.reasons();
    const route=this.route;const tracker=new RouteProgressTracker(route.centerline,route.widthM);
    // Explicit selection targets win, then the route's own, then the calibrated table (see src/events/medal-targets.ts).
    const medalTargets=validMedalTargets(selection.mode,selection.medalTargets)?selection.medalTargets:medalTargetsFor(route,selection.mode,this.carId);
    this.medalTargets=medalTargets??null;
    const run=createRunController({eventId:`${route.id}:${selection.mode}`,routeId:route.id,mode:selection.mode,rulesVersion:selection.rulesVersion,carId:this.carId,routeVersion:route.version,physicsVersion:VEHICLE_PHYSICS_VERSION,tuneHash:this.tuneHash(),checkpoints:route.checkpoints,countdownSeconds:3,medalTargets});
    const scorer=createDriftScorer({rulesVersion:selection.rulesVersion,routeLengthM:route.lengthM,clippingZones:route.clippingZones});
    this.eventSelection={...selection};
    const spawn=offsetSpawn(this.route.spawn,this.gridOffset);this.gridOffset=null;
    this.simulation.setSpawn(spawn.position,spawn.rotation);this.clearInput();
    this.mode=selection.mode;this.result=null;this.presentation='drive';this.runAssist=this.assistLevel;
    this.session=new DrivingSession({simulation:this.simulation,run,scorer,recovery:this.makeRecovery(route),onRecovered:pose=>tracker.rebase(pose.position),routeEvidence:(_previous,current,checkpoints)=>{
      const p=tracker.update(current.position);
      // Obstacle ray hits must not supply the grounded-road requirement while
      // one remaining asphalt tire makes a wall ride look like legal drifting.
      const roadWheels=current.wheels.filter(w=>w.contact&&w.surfaceId!==null&&this.roadSurfaces.has(w.surfaceId)).length;
      const edgeWheels=current.wheels.filter(w=>w.contact&&w.surfaceId!==null&&this.edgeSurfaces.has(w.surfaceId)).length;
      return {routeProgressM:p.progressM,routeLateralOffsetM:p.lateralOffsetM??undefined,legalCorridor:p.legal,runViolation:p.violation??undefined,checkpointValid:!checkpoints?.invalidCrossing,roadContact:roadWheels>=3,surfaceContact:roadWheels+edgeWheels>=3};
    },onRunFinished:result=>{
      const stamped:RunResult={...result,assist:this.runAssist};
      this.result=stamped;run.showResults();this.pause('menu');this.onResult?.(stamped);
    }});
    for(const reason of reasons)if(reason!=='menu'&&reason!=='manual')this.session.pauses.add(reason);
    if(document.hidden)this.pause('hidden');run.startCountdown();this.resetCameraHistory();this.lastTime=performance.now();
  }
  /** One-shot: the next beginEvent starts this far right of and behind the route spawn (online starting grid). */
  armGridOffset(offset:{readonly rightM:number;readonly backM:number}|null):void {
    this.gridOffset=offset&&Number.isFinite(offset.rightM)&&Number.isFinite(offset.backM)?{rightM:offset.rightM,backM:offset.backM}:null;
  }
  retry():void {if(this.eventSelection)this.beginEvent(this.eventSelection);}
  resetVehicle():void {this.session.resetToSafePoint();this.clearInput();this.resetCameraHistory();}
  tuneHash():string {return compatibilityId(this.simulation.getTuneIdentity());}
  ghostRecording(){return this.session.ghostRecording();}
  setRival(samples:readonly GhostTransform[]):void {this.rival=samples;}
  setGhostVisible(visible:boolean):void {this.ghostVisible=visible;if(!visible)this.scene.setGhost(null);}
  quality():Readonly<{selection:QualitySelection;effective:QualityPreset}> {return {selection:this.qualitySelection,effective:this.effectiveQuality};}
  setQuality(selection:QualitySelection):void {
    if(!(['auto','low','balanced','high','ultra'] as readonly string[]).includes(selection))throw new Error('Unknown graphics selection');
    if(selection===this.qualitySelection)return;
    const next=selection==='auto'?this.autoInitial:selection;
    // Commit selection only after the renderer accepts it.
    if(next!==this.effectiveQuality)this.scene.setQuality(next);
    if(selection==='auto')this.autoQuality.reset();else this.autoQuality.lockFixed(selection);
    this.qualitySelection=selection;this.effectiveQuality=next;
    this.applyResolutionScale();
  }
  private applyResolutionScale():void {
    const scale=this.autoQuality.resolutionScale;
    if(scale===this.appliedResolutionScale)return;
    this.appliedResolutionScale=scale;this.scene.setResolutionScale?.(scale);
  }
  enterReplay():boolean {
    this.replay=this.session.freezeReplay();if(this.replay.length<2)return false;
    this.replayTime=this.replay[0].timeSeconds;this.presentation='replay';this.pause('menu');this.scene.setGhost(null);return true;
  }
  /** Replays recorded poses (a whole finished run at 15 Hz, see src/ghosts) instead of the 12 s ring. */
  enterReplayWith(samples:readonly GhostTransform[]):boolean {
    if(!Array.isArray(samples)||samples.length<2)return false;
    this.replay=samples;this.replayTime=samples[0].timeSeconds;this.replaySpeed=1;this.presentation='replay';this.pause('menu');this.scene.setGhost(null);return true;
  }
  setReplaySpeed(speed:number):void {this.replaySpeed=Number.isFinite(speed)?Math.max(0,Math.min(4,speed)):1;}
  /** Jumps the replay to a position from 0 (start) to 1 (end). */
  seekReplay(progress:number):void {
    if(this.replay.length<2)return;const start=this.replay[0].timeSeconds,end=this.replay.at(-1)!.timeSeconds;
    this.replayTime=start+(end-start)*(Number.isFinite(progress)?Math.max(0,Math.min(1,progress)):0);
  }
  replayClock():{readonly time:number;readonly duration:number;readonly speed:number} {
    if(this.replay.length<2)return {time:0,duration:0,speed:this.replaySpeed};
    const start=this.replay[0].timeSeconds;return {time:this.replayTime-start,duration:this.replay.at(-1)!.timeSeconds-start,speed:this.replaySpeed};
  }
  enterPhoto():void {this.presentation='photo';this.pause('menu');}
  leavePresentation():void {this.presentation='drive';this.replay=[];this.replaySpeed=1;if(!this.result)this.resume('menu');this.resetCameraHistory();}
  async screenshot():Promise<Blob> {
    this.scene.renderer.render(this.scene.scene,this.scene.camera);
    return new Promise((resolve,reject)=>this.scene.renderer.domElement.toBlob(blob=>blob?resolve(blob):reject(new Error('Screenshot unavailable')), 'image/png'));
  }
  dispose():void {if(this.disposed)return;this.disposed=true;this.carOperation++;cancelAnimationFrame(this.raf);this.detachVisibility();this.callbacks.clear();this.session.dispose();this.scene.dispose();}
  /** Crash recovery for one session: safe points on this route's road, never ahead of where the car got to. */
  private makeRecovery(route:RouteDefinition):RecoveryTracker {
    return new RecoveryTracker(route,{isRoadSurface:id=>this.roadSurfaces.has(id)});
  }
  private clearInput():void {
    this.input.clear();this.lastInput=neutralInput(this.simulation.snapshot().simulationTick);this.lastBrake=0;
  }
  private resetCameraHistory():void {
    if(this.cameraReset)this.cameraReset();else this.scene.resetCamera();
  }
  /** Seconds since the last rendered showcase frame; -1 outside the paused menu showcase. */
  private showcaseElapsed=-1;
  private frame=(now:number):void=>{
    if(this.disposed)return;
    const dt=Math.max(0,(now-this.lastTime)/1000);this.lastTime=now;
    let frame=this.session.advance(dt,tick=>{
      const input=this.input.read(tick);
      if(input.resetPressed)this.resetCameraHistory();
      return input;
    });
    this.lastInput=this.session.pauses.isPaused()?neutralInput(frame.current.simulationTick):this.session.lastInput();
    // In reverse the held brake is the reverse pedal, so it lights the reverse lamps rather than the brake lamps.
    this.lastBrake=frame.current.gear<0?0:this.lastInput.brake;
    if(!this.session.pauses.isPaused())this.metrics.record(dt*1000);
    if(frame.current.position.y < -20){if(!this.session.requestRecovery('fallen'))this.resetVehicle();frame=this.session.snapshot();}
    if(this.presentation==='replay') {
      const end=this.replay.at(-1)!.timeSeconds;this.replayTime+=Math.min(dt,.1)*this.replaySpeed;
      if(this.replayTime>end)this.replayTime=this.replay[0].timeSeconds;
      const sample=interpolateGhost(this.replay,this.replayTime);
      if(sample){const visual=transformSnapshot(frame.current,sample);frame={...frame,previous:visual,current:visual,interpolationAlpha:1};}
    }
    const rivalTime=this.session.run?.status().elapsedActiveSeconds??0;
    const rival=this.ghostVisible&&this.presentation==='drive'&&this.rival.length?interpolateGhost(this.rival,rivalTime):null;
    this.scene.setGhost(rival?transformSnapshot(frame.current,rival):null);
    // Menus, pause and results screens show a slow showcase camera: 30 fps is visually the same there and
    // halves GPU load (and laptop heat) while the player reads. Drive, replay and photo keep the full rate.
    // The first showcase frame always renders so the menu appears at once.
    const showcase=this.session.pauses.reasons().has('menu')&&this.presentation==='drive';
    if(!showcase)this.showcaseElapsed=-1;
    if(showcase&&this.showcaseElapsed>=0&&this.showcaseElapsed+dt<SHOWCASE_FRAME_SECONDS) {
      this.showcaseElapsed+=dt;this.autoQuality.sample(dt*1000,false);
    } else if(!this.session.pauses.reasons().has('context-lost')) {
      const renderDt=dt+Math.max(0,this.showcaseElapsed);if(showcase)this.showcaseElapsed=0;
      try {
        const quality=this.autoQuality.sample(dt*1000,!this.session.pauses.isPaused()&&this.presentation==='drive');
        if(quality!==this.effectiveQuality){this.scene.setQuality(quality);this.effectiveQuality=quality;}
        this.applyResolutionScale();
        this.cameraUpdate?.(frame,Math.min(renderDt,.1),this.presentation,this.session.pauses.isPaused());
        this.scene.render(frame,Math.min(renderDt,.1),{cameraManagedExternally:this.cameraUpdate!==null,brakePressed:this.lastBrake,simulationActive:!this.session.pauses.isPaused()});
      } catch(error) {
        this.pause('context-lost');this.renderFailure?.(error instanceof Error?error:new Error('Rendering stopped'));
      }
    } else this.autoQuality.sample(dt*1000,false);
    if(now>=this.nextMetricsAt){this.measured=this.metrics.summary();this.nextMetricsAt=now+500;}
    const view=this.view();for(const callback of this.callbacks)callback(view);
    this.raf=requestAnimationFrame(this.frame);
  };
}

/** Visual transform only. It never writes back into the Rapier body or event state. */
function transformSnapshot(base:VehicleSnapshot,transform:GhostTransform):VehicleSnapshot {
  const oldRotation=new THREE.Quaternion().copy(base.rotation);const delta=new THREE.Quaternion().copy(transform.rotation).multiply(oldRotation.invert());
  const oldPosition=new THREE.Vector3().copy(base.position);const newPosition=new THREE.Vector3().copy(transform.position);
  const wheels=base.wheels.map(w=>{const p=new THREE.Vector3().copy(w.position).sub(oldPosition).applyQuaternion(delta).add(newPosition);const q=new THREE.Quaternion().copy(w.rotation).premultiply(delta);return {...w,position:{x:p.x,y:p.y,z:p.z},rotation:{x:q.x,y:q.y,z:q.z,w:q.w}};}) as unknown as VehicleSnapshot['wheels'];
  return {...base,position:transform.position,rotation:transform.rotation,driftAngleRad:transform.driftAngleRad,gear:transform.gear,wheels};
}

function neutralInput(simulationTick:number):InputFrame {
  return {simulationTick,throttle:0,brake:0,steering:0,handbrake:0,shift:0,resetPressed:false};
}

/** Moves a spawn along its own heading: +rightM to the right, +backM backwards. */
export function offsetSpawn(spawn:{readonly position:Vec3;readonly rotation:Quat},offset:{readonly rightM:number;readonly backM:number}|null):{position:Vec3;rotation:Quat} {
  if(!offset||(!offset.rightM&&!offset.backM))return {position:{...spawn.position},rotation:{...spawn.rotation}};
  const q=spawn.rotation;
  // Local -Z is forward.
  let fx=-2*(q.x*q.z+q.w*q.y),fz=-(1-2*(q.x*q.x+q.y*q.y));
  const len=Math.hypot(fx,fz)||1;fx/=len;fz/=len;
  const p=spawn.position;
  return {position:{x:p.x-fz*offset.rightM-fx*offset.backM,y:p.y+Math.min(.4,Math.abs(offset.backM)*.04),z:p.z+fx*offset.rightM-fz*offset.backM},rotation:{...q}};
}

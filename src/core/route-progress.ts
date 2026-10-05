import type { Vec3 } from '../../contracts/runtime-contracts';
/** Per-tick travel below the recovery tracker's stuck speed (0.8 m/s at 60 Hz). */
const STALLED_STEP_M=0.8/60;
/** Project onto a bounded forward neighborhood, so parallel streets cannot teleport progress. */
export class RouteProgressTracker {
  private readonly cumulative: number[] = [0];
  private segment = 0;
  private furthest = 0;
  private projected = 0;
  private offRouteSeconds = 0;
  private previous: Vec3 | null = null;
  readonly lengthM: number;
  constructor(readonly points:readonly Vec3[],readonly widthM:number) {
    if(points.length<2||!Number.isFinite(widthM)||widthM<=0)throw new Error('Route needs a polyline and finite positive width');
    if(points.some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw new Error('Route positions must be finite');
    for(let i=1;i<points.length;i++)this.cumulative.push(this.cumulative[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y,points[i].z-points[i-1].z));
    this.lengthM=this.cumulative.at(-1)!;
    if(this.lengthM<=1e-6)throw new Error('Route must have nonzero length');
  }
  /** A recovery moved the car back along the route: re-anchor projection there. Earned progress is never extended. */
  rebase(position:Vec3):void {
    let best=Infinity,progress=this.projected,segment=this.segment;
    for(let i=Math.max(0,this.segment-12);i<Math.min(this.points.length-1,this.segment+3);i++){
      const a=this.points[i],b=this.points[i+1],dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz;
      const t=l2?Math.max(0,Math.min(1,((position.x-a.x)*dx+(position.y-a.y)*dy+(position.z-a.z)*dz)/l2)):0;
      const d=Math.hypot(position.x-a.x-t*dx,position.y-a.y-t*dy,position.z-a.z-t*dz);
      if(d<best){best=d;progress=this.cumulative[i]+t*Math.sqrt(l2);segment=i;}
    }
    this.projected=progress;this.segment=segment;this.furthest=Math.min(this.furthest,progress);
    this.previous={...position};this.offRouteSeconds=0;
  }
  reset():void {this.segment=0;this.furthest=0;this.projected=0;this.offRouteSeconds=0;this.previous=null;}
  update(position:Vec3,activeDt=1/60):{progressM:number;legal:boolean;distanceM:number;lateralOffsetM:number|null;segment:number;violation:'shortcut'|'wrong-way'|null} {
    if(![position.x,position.y,position.z].every(Number.isFinite))return {progressM:this.furthest,legal:false,distanceM:Infinity,lateralOffsetM:null,segment:this.segment,violation:'shortcut'};
    const travelled=this.previous?Math.hypot(position.x-this.previous.x,position.y-this.previous.y,position.z-this.previous.z):0;
    let nearest=Infinity,progress=this.furthest,bestSegment=this.segment,plausible=false;
    let lateralOffsetM:number|null=null;
    let fallbackDistance=Infinity,fallbackProgress=this.projected;
    // Inside a polyline vertex the next segment's projection starts ahead of the current one by roughly
    // 2 * offset * tan(turn / 2): with coarse centerlines and a wide line (run-off shoulder) that gap exceeds the
    // per-tick allowance and the projection used to stall at the vertex until the car read as off route.
    let currentT=0,next:{progress:number;distance:number;lateral:number|null}|null=null;
    for(let i=Math.max(0,this.segment-3);i<Math.min(this.points.length-1,this.segment+9);i++) {
      const a=this.points[i],b=this.points[i+1],dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z;
      const length2=dx*dx+dy*dy+dz*dz;
      const t=length2?Math.max(0,Math.min(1,((position.x-a.x)*dx+(position.y-a.y)*dy+(position.z-a.z)*dz)/length2)):0;
      const distance=Math.hypot(position.x-a.x-t*dx,position.y-a.y-t*dy,position.z-a.z-t*dz);
      const candidateProgress=this.cumulative[i]+t*Math.sqrt(length2);
      if(i===this.segment)currentT=t;
      if(i===this.segment+1){const hl=Math.hypot(dx,dz);next={progress:candidateProgress,distance,lateral:hl>1e-6?((position.x-a.x-t*dx)*-dz+(position.z-a.z-t*dz)*dx)/hl:null};}
      if(distance<fallbackDistance){fallbackDistance=distance;fallbackProgress=candidateProgress;}
      const candidatePlausible=Math.abs(candidateProgress-this.projected)<=Math.max(2,travelled*1.3+.25)&&travelled<=15;
      // Nearby parallel roads and a hairpin's return leg must not steal projection.
      if(candidatePlausible&&distance<nearest){
        nearest=distance;progress=candidateProgress;bestSegment=i;plausible=true;
        const horizontalLength=Math.hypot(dx,dz);
        lateralOffsetM=horizontalLength>1e-6?((position.x-a.x-t*dx)*-dz+(position.z-a.z-t*dz)*dx)/horizontalLength:null;
      }
    }
    this.previous={...position};
    const corridorM=this.widthM*.5+1.5;
    // Past the end of the current segment and inside the corridor of the next: creep the projection forward at
    // the plausible per-tick rate until it catches up. Never skips a segment; awarded progress stays rate-limited.
    if(next&&currentT>=.999&&travelled<=15&&next.distance<=corridorM&&next.progress>this.projected&&(!plausible||next.distance<nearest)){
      progress=Math.min(next.progress,this.projected+Math.max(2,travelled*1.3+.25));
      nearest=next.distance;lateralOffsetM=next.lateral;plausible=true;
      bestSegment=progress>=this.cumulative[this.segment+1]!?this.segment+1:this.segment;
    }
    if(!plausible){nearest=fallbackDistance;progress=fallbackProgress;}
    const inCorridor=nearest<=corridorM;
    const legal=inCorridor&&plausible;
    // A short runoff can rejoin without a permanently stale progress baseline. An
    // impossible projection jump is never adopted, including on subsequent ticks.
    if(plausible){this.projected=progress;this.segment=bestSegment;}
    // Nearest-segment projection can jump at an inside corner even when the car
    // moves continuously. Keep that raw projection for route navigation, but
    // award only progress the car could physically cover in this step. This
    // stays below the scorer's independent anti-teleport allowance.
    if(legal)this.furthest=Math.max(this.furthest,Math.min(progress,this.furthest+Math.max(.24,travelled*1.2)));
    // A car stopped outside the corridor (beached past a barrier after a crash) gains no ground: let the stuck
    // auto-recovery (3 s) bring it back instead of calling the 2 s sustained runoff a shortcut first.
    const moving=travelled>=STALLED_STEP_M;
    this.offRouteSeconds=inCorridor?0:moving?this.offRouteSeconds+Math.max(0,Math.min(activeDt,1/30)):this.offRouteSeconds;
    // Wrong-way needs a trustworthy projection: off the corridor the sustained-runoff rule decides instead.
    const violation=!plausible||this.offRouteSeconds>2?'shortcut':legal&&progress<this.furthest-8?'wrong-way':null;
    return {progressM:this.furthest,legal,distanceM:nearest,lateralOffsetM,segment:this.segment,violation};
  }
}

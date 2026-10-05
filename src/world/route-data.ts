import * as THREE from 'three';
import routeData from '../../content/routes/hw-01.json';
import type { CollisionMeshData, RouteDefinition, WorldCheckpoint } from '../../contracts/world-contracts';

export function sampleHarborRoute(): THREE.Vector3[] {
  const controls = routeData.controlPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  return new THREE.CatmullRomCurve3(controls, true, 'centripetal', 0.5).getPoints(256).slice(0, -1);
}
const vec = (p: THREE.Vector3): { x: number; y: number; z: number } => ({ x: p.x, y: p.y, z: p.z });
const normalize = (p: THREE.Vector3): THREE.Vector3 => p.clone().normalize();
const guardrailOffsetM=routeData.widthM/2+2.15;

function yawFromForward(forward: THREE.Vector3): { x: number; y: number; z: number; w: number } {
  const yaw = Math.atan2(-forward.x, -forward.z);
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

export function buildHarborRoute(): { route: RouteDefinition; collision: CollisionMeshData } {
  const points = sampleHarborRoute();
  const checkpoints: WorldCheckpoint[] = [];
  const spawnIndex = Math.floor(points.length / 2);
  const gateOffsets = [8, 43, 78, 112, 147, 182, 217, 252] as const;
  for (let i = 0; i < gateOffsets.length; i++) {
    const index = (spawnIndex + gateOffsets[i]!) % points.length;
    const p = points[index]!;
    const tangent = normalize(points[(index + 1) % points.length]!.clone().sub(points[(index - 1 + points.length) % points.length]!));
    checkpoints.push({ id: `HW01-CP-${String(i + 1).padStart(2, '0')}`, center: { x: p.x, y: p.y + 0.12, z: p.z },
      forward: vec(tangent), halfWidthM: routeData.widthM / 2 - 1.1, ...(i === gateOffsets.length - 1 ? { finish: true } : {}) });
  }
  const spawnPoint = points[spawnIndex]!;
  const spawnForward = normalize(points[(spawnIndex + 1) % points.length]!.clone().sub(points[(spawnIndex - 1 + points.length) % points.length]!));
  const spawn = { position: { x: spawnPoint.x, y: spawnPoint.y + 0.93, z: spawnPoint.z }, rotation: yawFromForward(spawnForward) };
  let lengthM = 0;
  for (let i = 0; i < points.length; i++) lengthM += points[i]!.distanceTo(points[(i + 1) % points.length]!);
  const startOrdered = points.slice(spawnIndex).concat(points.slice(0, spawnIndex));
  const centerline = startOrdered.filter((_, i) => i % 4 === 0).map(vec);
  centerline.push(centerline[0]!);
  const route: RouteDefinition = {
    id: routeData.id as RouteDefinition['id'], name: routeData.name, district: routeData.district as RouteDefinition['district'], version: routeData.version,
    roadIds: [routeData.roadId], centerline, widthM: routeData.widthM, closed: routeData.closed, lengthM, spawn, checkpoints,
    clippingZones: routeData.clippingZones,
  };
  const vertices: { x: number; y: number; z: number }[] = [], indices: number[] = [];
  const half = routeData.widthM / 2;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, prev = points[(i - 1 + points.length) % points.length]!, next = points[(i + 1) % points.length]!;
    const tangent = normalize(next.clone().sub(prev));
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    vertices.push({ x: p.x - right.x * half, y: p.y + 0.08, z: p.z - right.z * half });
    vertices.push({ x: p.x + right.x * half, y: p.y + 0.08, z: p.z + right.z * half });
  }
  const addUpwardTriangle = (a: number, b: number, c: number): void => {
    const pa = vertices[a]!, pb = vertices[b]!, pc = vertices[c]!;
    const up = (pb.z-pa.z)*(pc.x-pa.x) - (pb.x-pa.x)*(pc.z-pa.z);
    if (up > 0) indices.push(a,b,c); else indices.push(a,c,b);
  };
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length, a = i * 2, b = j * 2;
    addUpwardTriangle(a, a + 1, b);
    addUpwardTriangle(a + 1, b + 1, b);
  }
  return { route, collision: { vertices, indices, surfaceId: routeData.roadId, drivableRoad: true } };
}

export function buildHarborApronCollision(): CollisionMeshData {
  const bounds: readonly (readonly [number,number,number,number])[] = [
    [-300,137,-240,240], [229,300,-240,240], [137,229,-240,32], [137,229,104,240],
  ];
  const vertices: {x:number;y:number;z:number}[] = [], indices: number[] = [];
  for (const [minX,maxX,minZ,maxZ] of bounds) {
    const base=vertices.length;
    vertices.push({x:minX,y:-.62,z:minZ},{x:maxX,y:-.62,z:minZ},{x:minX,y:-.62,z:maxZ},{x:maxX,y:-.62,z:maxZ});
    indices.push(base,base+2,base+1,base+1,base+2,base+3);
  }
  return { vertices, indices, surfaceId: 'ground:harbor:apron', drivableRoad: false };
}

export function buildHarborWaterCollision(): CollisionMeshData {
  return {
    vertices: [{x:137,y:-.62,z:32},{x:229,y:-.62,z:32},{x:137,y:-.62,z:104},{x:229,y:-.62,z:104}],
    indices: [0,2,1,1,2,3], surfaceId: 'water:harbor:basin', drivableRoad: false,
  };
}


export function buildHarborCurbCollisions(): readonly [CollisionMeshData, CollisionMeshData] {
  const points=sampleHarborRoute(), width=routeData.widthM, halfBand=.55, centerOffset=width/2+halfBand;
  const build=(side:-1|1):CollisionMeshData=>{
    const vertices:{x:number;y:number;z:number}[]=[],indices:number[]=[];
    for(let i=0;i<points.length;i++){
      const p=points[i]!,prev=points[(i-1+points.length)%points.length]!,next=points[(i+1)%points.length]!;
      const tangent=normalize(next.clone().sub(prev)),right=new THREE.Vector3(-tangent.z,0,tangent.x).normalize();
      const cx=p.x+right.x*side*centerOffset,cz=p.z+right.z*side*centerOffset;
      vertices.push({x:cx-right.x*halfBand,y:p.y+.04,z:cz-right.z*halfBand},{x:cx+right.x*halfBand,y:p.y+.04,z:cz+right.z*halfBand});
    }
    const addUp=(a:number,b:number,c:number):void=>{
      const pa=vertices[a]!,pb=vertices[b]!,pc=vertices[c]!;
      const up=(pb.z-pa.z)*(pc.x-pa.x)-(pb.x-pa.x)*(pc.z-pa.z);
      if(up>0)indices.push(a,b,c);else indices.push(a,c,b);
    };
    for(let i=0;i<points.length;i++){
      const j=(i+1)%points.length,a=i*2,b=j*2;
      addUp(a,a+1,b);addUp(a+1,b+1,b);
    }
    // Flat run-off shoulder from the curb out to just past the guardrail line. Without it the outer wheels drop into
    // the gap in front of the rail and the chassis catches the road edge, turning a light brush into a dead stop.
    const shoulderBase=vertices.length,shoulderOuter=guardrailOffsetM+.3;
    for(let i=0;i<points.length;i++){
      const p=points[i]!,prev=points[(i-1+points.length)%points.length]!,next=points[(i+1)%points.length]!;
      const tangent=normalize(next.clone().sub(prev)),right=new THREE.Vector3(-tangent.z,0,tangent.x).normalize();
      const inner=centerOffset+halfBand-.02;
      vertices.push({x:p.x+right.x*side*inner,y:p.y+.04,z:p.z+right.z*side*inner},{x:p.x+right.x*side*shoulderOuter,y:p.y+.04,z:p.z+right.z*side*shoulderOuter});
    }
    for(let i=0;i<points.length;i++){
      const j=(i+1)%points.length,a=shoulderBase+i*2,b=shoulderBase+j*2;
      addUp(a,a+1,b);addUp(a+1,b+1,b);
    }
    return {vertices,indices,surfaceId:`curb:harbor:hw01:${side<0?'left':'right'}`,drivableRoad:false};
  };
  return [build(-1),build(1)];
}

/** Two continuous compact steel rail prisms; role is obstacle so wall telemetry sees contact. */
export function buildHarborGuardrailCollisions(): readonly [CollisionMeshData,CollisionMeshData] {
  const points=sampleHarborRoute(),railHeightCenters=[.44,.79] as const;
  const build=(side:-1|1):CollisionMeshData=>{
    const vertices:{x:number;y:number;z:number}[]=[],indices:number[]=[];
    const anchors=points.map((p,i)=>{
      const prev=points[(i-1+points.length)%points.length]!,next=points[(i+1)%points.length]!;
      const tangent=normalize(next.clone().sub(prev)),right=new THREE.Vector3(-tangent.z,0,tangent.x).normalize();
      return {point:new THREE.Vector3(p.x+right.x*side*guardrailOffsetM,p.y+.08,p.z+right.z*side*guardrailOffsetM),tangent,right};
    });
    const addTriangle=(a:number,b:number,c:number,outward:THREE.Vector3):void=>{
      const pa=vertices[a]!,pb=vertices[b]!,pc=vertices[c]!;
      const normal=new THREE.Vector3(pb.x-pa.x,pb.y-pa.y,pb.z-pa.z).cross(new THREE.Vector3(pc.x-pa.x,pc.y-pa.y,pc.z-pa.z));
      if(normal.dot(outward)>=0)indices.push(a,b,c);else indices.push(a,c,b);
    };
    for(const railHeight of railHeightCenters){
      const base=vertices.length;
      for(const anchor of anchors){
        const center=anchor.point.clone().add(new THREE.Vector3(0,railHeight,0));
        for(const [lateral,vertical] of [[-.07,-.06],[.07,-.06],[.07,.06],[-.07,.06]] as const){
          const v=center.clone().addScaledVector(anchor.right,lateral*side).add(new THREE.Vector3(0,vertical,0));
          vertices.push(vec(v));
        }
      }
      for(let i=0;i<anchors.length;i++)for(let edge=0;edge<4;edge++){
        const nextEdge=(edge+1)%4,nextI=(i+1)%anchors.length,a=base+i*4+edge,b=base+i*4+nextEdge,c=base+nextI*4+edge,d=base+nextI*4+nextEdge;
        const radial=anchors[i]!.right.clone().multiplyScalar(side*((edge===1)?1:(edge===3)?-1:0)).add(new THREE.Vector3(0,edge===0?-1:edge===2?1:0,0));
        if(radial.lengthSq()<.1)radial.copy(anchors[i]!.tangent.clone().cross(anchors[i]!.right).multiplyScalar(side));
        addTriangle(a,c,b,radial);addTriangle(b,c,d,radial);
      }
    }
    // Solid collision curtain on the rail line, from below the apron up to 1.5 m (above the top rail, so a car riding the rail cannot climb it). Without it a car whose
    // outer wheels drop off the shoulder slides under the thin rails; with it the guardrail deflects every hit.
    const curtainBase=vertices.length;
    for(const anchor of anchors){
      vertices.push(vec(anchor.point.clone().add(new THREE.Vector3(0,-1.2,0))),vec(anchor.point.clone().add(new THREE.Vector3(0,1.5,0))));
    }
    for(let i=0;i<anchors.length;i++){
      const nextI=(i+1)%anchors.length,a=curtainBase+i*2,b=a+1,c=curtainBase+nextI*2,d=c+1;
      const inward=anchors[i]!.right.clone().multiplyScalar(-side);
      addTriangle(a,c,b,inward);addTriangle(b,c,d,inward);
    }
    return {vertices,indices,surfaceId:`barrier:harbor:hw01:${side<0?'left':'right'}`,drivableRoad:false,role:'obstacle'};
  };
  return [build(-1),build(1)];
}

import * as THREE from 'three';
import routeData from '../../content/routes/hw-01.json';

/** Hand-authored, editable control points for the original Harbor Works Foundry Eight. */
export const HARBOR_ROUTE = routeData;

const mat = (name: string, color: string, roughness: number, metalness = 0) => {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  material.name = name;
  return material;
};

function surfaceGeometry(points: readonly THREE.Vector3[], width: number, yOffset: number, thickness: number): THREE.BufferGeometry {
  const vertices: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let distance=0;
  const half = width / 2;
  for (let i = 0; i < points.length; i++) {
    if(i>0) distance+=points[i]!.distanceTo(points[i-1]!);
    const along=distance/3;
    const prev = points[(i - 1 + points.length) % points.length]!;
    const next = points[(i + 1) % points.length]!;
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const inv = 1 / Math.hypot(dx, dz);
    const rx = -dz * inv, rz = dx * inv;
    const p = points[i]!;
    vertices.push(p.x - rx * half, p.y + yOffset, p.z - rz * half);
    vertices.push(p.x + rx * half, p.y + yOffset, p.z + rz * half);
    vertices.push(p.x - rx * half, p.y + yOffset - thickness, p.z - rz * half);
    vertices.push(p.x + rx * half, p.y + yOffset - thickness, p.z + rz * half);
    uvs.push(0,along,width/3,along,0,along,width/3,along);
    const variation = .88 + .12 * (.5 + .5 * Math.sin(p.x*.11 + Math.sin(p.z*.07)) * Math.cos(p.z*.15 - p.x*.025));
    for (let j = 0; j < 4; j++) colors.push(variation, variation, variation);
  }
  const n = points.length;
  const topFace = (a: number, b: number, c: number): void => {
    const ax = vertices[a*3]!, az = vertices[a*3+2]!, bx = vertices[b*3]!, bz = vertices[b*3+2]!, cx = vertices[c*3]!, cz = vertices[c*3+2]!;
    const up = (bz-az)*(cx-ax) - (bx-ax)*(cz-az);
    if (up > 0) indices.push(a,b,c); else indices.push(a,c,b);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = i * 4, b = j * 4;
    // Top face winding is checked per segment so the closed seam remains +Y.
    topFace(a, a + 1, b); topFace(a + 1, b + 1, b);
    indices.push(a + 2, b + 2, a, a, b + 2, b);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function ribbonGeometry(points: readonly THREE.Vector3[], width: number, yOffset: number): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  const uvs:number[]=[];
  const half = width / 2;
  let distance=0;
  for (let i = 0; i < points.length; i++) {
    if(i>0) distance+=points[i]!.distanceTo(points[i-1]!);
    const prev = points[(i - 1 + points.length) % points.length]!;
    const next = points[(i + 1) % points.length]!;
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const inv = 1 / Math.hypot(dx, dz), rx = -dz * inv, rz = dx * inv;
    const p = points[i]!;
    positions.push(p.x - rx * half, p.y + yOffset, p.z - rz * half, p.x + rx * half, p.y + yOffset, p.z + rz * half);
    uvs.push(0,distance/2,width/2,distance/2);
  }
  const topFace = (a: number, b: number, c: number): void => {
    const ax = positions[a*3]!, az = positions[a*3+2]!, bx = positions[b*3]!, bz = positions[b*3+2]!, cx = positions[c*3]!, cz = positions[c*3+2]!;
    const up = (bz-az)*(cx-ax) - (bx-ax)*(cz-az);
    if (up > 0) indices.push(a,b,c); else indices.push(a,c,b);
  };
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length, a = i * 2, b = j * 2;
    topFace(a, a + 1, b); topFace(a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

function createHarborPoints(): THREE.Vector3[] {
  const controls = HARBOR_ROUTE.controlPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(controls, true, 'centripetal', 0.5);
  return curve.getPoints(256).slice(0, -1);
}

function addBox(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, name: string,
  position: readonly [number, number, number], scale?: readonly [number, number, number], rotationY = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name; mesh.position.set(...position); mesh.rotation.y = rotationY;
  if (scale) mesh.scale.set(...scale);
  mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

interface StaticBatchInstance {
  readonly sourceName: string;
  readonly position: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
}

/**
 * Adds spatially bounded repeated detail as one instanced draw. Per-source names
 * are retained in instance order in userData for editable-source traceability.
 */
function addStaticBatch(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material,
  name: string, instances: readonly StaticBatchInstance[]): THREE.InstancedMesh {
  const batch = new THREE.InstancedMesh(geometry, material, instances.length);
  batch.name = name;
  batch.castShadow = true;
  batch.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  instances.forEach((instance, index) => {
    position.set(...instance.position);
    scale.set(...(instance.scale ?? [1, 1, 1]));
    rotation.set(...(instance.rotation ?? [0, 0, 0]));
    quaternion.setFromEuler(rotation);
    matrix.compose(position, quaternion, scale);
    batch.setMatrixAt(index, matrix);
  });
  batch.instanceMatrix.needsUpdate = true;
  batch.computeBoundingBox();
  batch.computeBoundingSphere();
  batch.userData.batchKind = 'static-detail';
  batch.userData.sourceInstances = instances.map(({ sourceName }) => sourceName);
  parent.add(batch);
  return batch;
}

function appendOrientedBox(positions:number[],indices:number[],width:number,height:number,depth:number,center:THREE.Vector3,yaw:number):void {
  const geometry=new THREE.BoxGeometry(width,height,depth);
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(center));
  const position=geometry.getAttribute('position'),base=positions.length/3;
  for(let i=0;i<position.count;i++)positions.push(position.getX(i),position.getY(i),position.getZ(i));
  const source=geometry.index;
  for(let i=0;i<(source?.count??position.count);i++)indices.push(base+(source?source.getX(i):i));
  geometry.dispose();
}

/** Deterministic source scene used by both GLB export and route/collision generation. */
export function createHarborSource(): THREE.Group {
  const root = new THREE.Group(); root.name = 'HarborWorks_HW01';
  const points = createHarborPoints();
  const asphalt = mat('road-asphalt', '#343a3d', 0.88); asphalt.vertexColors = true;
  const curb = mat('curb-painted-concrete', '#a8a49a', 0.78);
  const concrete = mat('concrete-weathered', '#737b78', 0.91);
  const steel = mat('steel-oxidized', '#596866', 0.64, 0.48);
  const shedPaint = mat('shed-deep-teal', '#31545a', 0.72, 0.12);
  const warm = mat('sodium-lamp', '#ffb85d', 0.34, 0.05);
  const water = mat('harbor-water', '#244e59', 0.42, 0.32);

  const road = new THREE.Mesh(surfaceGeometry(points, HARBOR_ROUTE.widthM, 0.08, 0.52), asphalt);
  road.name = 'road-hw01-asphalt'; road.receiveShadow = true; root.add(road);
  const repairMat = mat('asphalt-repair', '#3b4140', .93);
  const blendedRepairMat = mat('asphalt-repair', '#ffffff', .95); blendedRepairMat.vertexColors = true;
  const dampMat = mat('asphalt-damp', '#303b3e', .52, .04);
  for (const [k, index] of [19, 47, 82, 121, 129, 134, 141, 150, 171, 207, 238].entries()) {
    const p = points[index]!, before = points[(index - 1 + points.length) % points.length]!, after = points[(index + 1) % points.length]!;
    const tangent = new THREE.Vector3(after.x-before.x, 0, after.z-before.z).normalize();
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const isEarlyVisibleRepair = k === 7;
    const sizeScale = isEarlyVisibleRepair ? .58 : 1;
    const halfLength = (0.8 + (k % 4) * .16) * sizeScale, halfWidth = (.42 + (k % 3) * .13) * (isEarlyVisibleRepair ? .64 : 1);
    const outline = isEarlyVisibleRepair ? [
      [-1, -.16], [-.76, -.72], [-.25, -1], [.48, -.81], [.94, -.45], [1, .12], [.74, .68], [.17, .92], [-.48, .82], [-.93, .48],
    ] : [
      [-halfLength, -halfWidth*.48], [-halfLength*.62, -halfWidth], [halfLength*.38, -halfWidth*.82],
      [halfLength, -halfWidth*.22], [halfLength*.78, halfWidth*.64], [-halfLength*.08, halfWidth], [-halfLength*.76, halfWidth*.62],
    ];
    const vertices = outline.map(([along, across]) => {
      const distanceAlong = isEarlyVisibleRepair ? along! * halfLength : along!;
      const distanceAcross = isEarlyVisibleRepair ? across! * halfWidth : across!;
      const x = p.x + tangent.x*distanceAlong + right.x*distanceAcross;
      const z = p.z + tangent.z*distanceAlong + right.z*distanceAcross;
      // Match the road strip's interpolated centerline grade so the repair sits
      // on its rendered triangles instead of floating over a sloped segment.
      let surfaceY = p.y + .08, bestDistance = Number.POSITIVE_INFINITY;
      for (let segment=0;segment<points.length;segment++) {
        const a=points[segment]!,b=points[(segment+1)%points.length]!;
        const dx=b.x-a.x,dz=b.z-a.z,lengthSq=dx*dx+dz*dz;
        const t=THREE.MathUtils.clamp(((x-a.x)*dx+(z-a.z)*dz)/lengthSq,0,1);
        const nearX=a.x+dx*t,nearZ=a.z+dz*t,distSq=(x-nearX)**2+(z-nearZ)**2;
        if(distSq<bestDistance){bestDistance=distSq;surfaceY=a.y+(b.y-a.y)*t+.08;}
      }
      return new THREE.Vector3(x, surfaceY + (isEarlyVisibleRepair ? .0015 : .007), z);
    });
    const positions = vertices.flatMap((v) => [v.x,v.y,v.z]);
    const uvs=outline.flatMap(([along,across])=>[
      ((isEarlyVisibleRepair ? across!*halfWidth : across!)/3),((isEarlyVisibleRepair ? along!*halfLength : along!)/3),
    ]);
    const indices: number[] = [];
    for (let i=0;i<vertices.length;i++) {
      const j=(i+1)%vertices.length, a=vertices[i]!, b=vertices[j]!;
      const up=(b.z-p.z)*(a.x-p.x)-(b.x-p.x)*(a.z-p.z);
      if (up > 0) indices.push(vertices.length,j,i); else indices.push(vertices.length,i,j);
    }
    positions.push(p.x,p.y+(isEarlyVisibleRepair ? .0815 : .087),p.z);
    uvs.push(0,0);
    const patchGeo = new THREE.BufferGeometry();
    patchGeo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    patchGeo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    if(isEarlyVisibleRepair) patchGeo.setAttribute('color',new THREE.Float32BufferAttribute(Array((vertices.length+1)*3).fill(.94),3));
    patchGeo.setIndex(indices); patchGeo.computeVertexNormals();
    const patchMaterial = isEarlyVisibleRepair ? blendedRepairMat : k % 3 === 1 ? dampMat : repairMat;
    const patch = new THREE.Mesh(patchGeo, patchMaterial);
    patch.name = `asphalt-repair-patch-${k}`; patch.receiveShadow = true; root.add(patch);
  }
  for (const side of [-1, 1]) {
    const edgePoints = points.map((p, i) => {
      const before = points[(i - 1 + points.length) % points.length]!, after = points[(i + 1) % points.length]!;
      const dx = after.x - before.x, dz = after.z - before.z, inv = 1 / Math.hypot(dx, dz);
      return new THREE.Vector3(p.x + (-dz * inv) * side * (HARBOR_ROUTE.widthM / 2 + 0.55), p.y + 0.04, p.z + (dx * inv) * side * (HARBOR_ROUTE.widthM / 2 + 0.55));
    });
    const curbMesh = new THREE.Mesh(ribbonGeometry(edgePoints, 1.1, 0), curb);
    curbMesh.name = `road-hw01-curb-${side < 0 ? 'left' : 'right'}`; curbMesh.receiveShadow = true; root.add(curbMesh);
  }
  const lineMat = mat('road-marking-pale', '#d5cbb4', 0.8);
  for (const side of [-1, 1]) {
    const linePoints = points.map((p, i) => {
      const before = points[(i - 1 + points.length) % points.length]!, after = points[(i + 1) % points.length]!;
      const dx = after.x - before.x, dz = after.z - before.z, inv = 1 / Math.hypot(dx, dz);
      return new THREE.Vector3(p.x + (-dz * inv) * side * 5.9, p.y + 0.10, p.z + (dx * inv) * side * 5.9);
    });
    const edgeLine = new THREE.Mesh(ribbonGeometry(linePoints, 0.18, 0), lineMat);
    edgeLine.name = `road-hw01-edge-line-${side}`; root.add(edgeLine);
  }
  // Two low, steel service-road guardrails keep a readable edge around the open apron.
  // Geometry is combined per side to avoid hundreds of individual draw calls.
  for(const side of [-1,1]){
    const positions:number[]=[],indices:number[]=[];
    const anchors=points.map((p,i)=>{
      const before=points[(i-1+points.length)%points.length]!,after=points[(i+1)%points.length]!;
      const tangent=new THREE.Vector3(after.x-before.x,0,after.z-before.z).normalize();
      const right=new THREE.Vector3(-tangent.z,0,tangent.x);
      return {point:new THREE.Vector3(p.x+right.x*side*8.9,p.y+.08,p.z+right.z*side*8.9)};
    });
    for(let i=0;i<anchors.length;i++){
      const a=anchors[i]!.point,b=anchors[(i+1)%anchors.length]!.point,delta=b.clone().sub(a),length=Math.hypot(delta.x,delta.z),yaw=Math.atan2(-delta.z,delta.x);
      const middle=a.clone().add(b).multiplyScalar(.5);
      appendOrientedBox(positions,indices,length+.08,.12,.14,middle.clone().add(new THREE.Vector3(0,.44,0)),yaw);
      appendOrientedBox(positions,indices,length+.08,.12,.14,middle.clone().add(new THREE.Vector3(0,.79,0)),yaw);
      if(i%4===0)appendOrientedBox(positions,indices,.14,.92,.14,a.clone().add(new THREE.Vector3(0,.46,0)),yaw);
    }
    const railGeometry=new THREE.BufferGeometry();
    railGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));railGeometry.setIndex(indices);railGeometry.computeVertexNormals();
    const rails=new THREE.Mesh(railGeometry,steel);rails.name=`road-hw01-guardrail-${side<0?'left':'right'}`;rails.castShadow=true;rails.receiveShadow=true;root.add(rails);
  }

  // Broad low-poly industrial scenery frames the turn without obscuring sightlines.
  const shedGeo = new THREE.BoxGeometry(1, 1, 1);
  addBox(root, shedGeo, shedPaint, 'loading-shed-main', [-180, 7, 30], [58, 14, 31], -0.08);
  addBox(root, shedGeo, concrete, 'loading-shed-roof', [-180, 14.2, 30], [60, 1, 33], -0.08);
  const doorMat = mat('loading-door', '#202f33', 0.92);
  for (let i = 0; i < 4; i++) addBox(root, shedGeo, doorMat, `shed-door-${i}`, [-202 + i * 14, 4.3, 13.9], [8, 8, 0.25], -0.08);
  // Put a second articulated loading face toward the eastbound road approach.
  for(let i=0;i<4;i++){
    const x=-202+i*14,yaw=-.08;
    const frontZ=(worldX:number):number=>{const localX=(worldX+180-15.5*Math.sin(yaw))/Math.cos(yaw);return 30-localX*Math.sin(yaw)+15.5*Math.cos(yaw)+.08;};
    const z=frontZ(x);
    addBox(root,shedGeo,steel,`shed-road-door-frame-${i}-left`,[x-4.58,4.35,frontZ(x-4.58)],[.22,8.75,.30],yaw);
    addBox(root,shedGeo,steel,`shed-road-door-frame-${i}-right`,[x+4.58,4.35,frontZ(x+4.58)],[.22,8.75,.30],yaw);
    addBox(root,shedGeo,steel,`shed-road-door-header-${i}`,[x,8.73,z],[9.35,.24,.30],yaw);
    addBox(root,shedGeo,doorMat,`shed-road-door-${i}`,[x,4.25,z+.04],[8.7,7.9,.12],yaw);
    addStaticBatch(root,shedGeo,concrete,`shed-road-door-rib-batch-${i}`,
      Array.from({length:5},(_,rib)=>({sourceName:`shed-road-door-rib-${i}-${rib}`,position:[x,1.25+rib*1.35,z+.15] as const,scale:[7.8,.07,.04] as const,rotation:[0,yaw,0] as const})));
    addBox(root,shedGeo,warm,`shed-road-door-safety-mark-${i}`,[x,8.15,z+.15],[8.2,.13,.05],yaw);
    for(const side of [-1,1])addBox(root,shedGeo,warm,`shed-road-dock-lamp-${i}-${side}`,[x+side*5,9.05,frontZ(x+side*5)],[.36,.5,.34],yaw);
  }
  // Eastbound early-route sightline sees the loading shed's east end. Give that
  // facade legible human-scale bays instead of the unbroken teal end wall.
  const shedLocalToWorld=(localX:number,localZ:number):THREE.Vector3=>new THREE.Vector3(
    -180+localX*Math.cos(-.08)+localZ*Math.sin(-.08),
    0,
    30-localX*Math.sin(-.08)+localZ*Math.cos(-.08),
  );
  for(let bay=0;bay<4;bay++){
    const localZ=-11.1+bay*7.4,doorCenter=shedLocalToWorld(29.15,localZ);
    addBox(root,shedGeo,doorMat,`shed-door-east-panel-${bay}`,[doorCenter.x,4.15,doorCenter.z],[.22,6.3,6.2],-.08);
    const frameInstances=[
      {sourceName:`shed-door-frame-east-${bay}-left`,position:[shedLocalToWorld(29.18,localZ-3.28).x,4.2,shedLocalToWorld(29.18,localZ-3.28).z] as const,scale:[.28,7.1,.24] as const,rotation:[0,-.08,0] as const},
      {sourceName:`shed-door-frame-east-${bay}-right`,position:[shedLocalToWorld(29.18,localZ+3.28).x,4.2,shedLocalToWorld(29.18,localZ+3.28).z] as const,scale:[.28,7.1,.24] as const,rotation:[0,-.08,0] as const},
      {sourceName:`shed-door-frame-east-${bay}-header`,position:[doorCenter.x,7.82,doorCenter.z] as const,scale:[.28,.25,6.8] as const,rotation:[0,-.08,0] as const},
    ];
    addStaticBatch(root,shedGeo,steel,`shed-door-frame-east-batch-${bay}`,frameInstances);
    addStaticBatch(root,shedGeo,steel,`shed-door-rib-east-batch-${bay}`,[1.7,2.8,3.9,5].map((y,rib)=>({
      sourceName:`shed-door-rib-east-${bay}-${rib}`,position:[shedLocalToWorld(29.31,localZ).x,y,shedLocalToWorld(29.31,localZ).z] as const,
      scale:[.08,.09,5.75] as const,rotation:[0,-.08,0] as const,
    })));
    addBox(root,shedGeo,warm,`shed-door-safety-mark-east-${bay}`,
      [doorCenter.x,8.03,doorCenter.z],[.10,.12,6.55],-.08);
  }
  addBox(root, shedGeo, water, 'inner-basin-water', [183, -.64, 68], [92, .04, 72]);
  // Crane booms and gantry legs are grouped into the same steel material draw family.
  for (const [ci, x] of [-226, -166, 196].entries()) {
    const crane = new THREE.Group(); crane.name = `dock-crane-${ci + 1}`; crane.position.set(x, 0, -72 + ci * 8); root.add(crane);
    addBox(crane, shedGeo, steel, 'crane-leg', [-10, 19, 0], [1.6, 38, 1.8]);
    addBox(crane, shedGeo, steel, 'crane-leg', [10, 19, 0], [1.6, 38, 1.8]);
    addBox(crane, shedGeo, steel, 'crane-gantry', [0, 38, 0], [25, 2.2, 2.5]);
    addBox(crane, shedGeo, steel, 'crane-boom', [21, 37, 0], [22, 1.5, 2], -0.08);
    addBox(crane, shedGeo, warm, 'crane-beacon', [0, 40, 0], [1.2, 0.8, 1.2]);
  }
  // A secondary machine hall and salt-storage tanks give the far quay depth from the road.
  const hallCenter = new THREE.Vector3(180, 0, -75);
  addBox(root,shedGeo,shedPaint,'east-quay-machine-hall',[hallCenter.x,7,hallCenter.z],[46,14,34],.12);
  addBox(root,shedGeo,concrete,'east-quay-machine-hall-roof',[hallCenter.x,14.2,hallCenter.z],[49,1.2,36],.12);
  addStaticBatch(root,shedGeo,steel,'machine-hall-rib-batch',Array.from({length:7},(_,i)=>({
    sourceName:`machine-hall-rib-${i}`,position:[hallCenter.x-19+i*6.2,7,hallCenter.z+17.2] as const,
    scale:[.32,12.8,.38] as const,rotation:[0,.12,0] as const,
  })));
  for(let i=0;i<3;i++){
    const x=hallCenter.x-12+i*12, z=hallCenter.z+17.22;
    addBox(root,shedGeo,steel,`machine-hall-bay-frame-${i}`,[x,4.35,z],[9.2,8.3,.34],.12);
    addBox(root,shedGeo,doorMat,`machine-hall-bay-${i}`,[x,4.25,z+.20],[8.5,7.7,.10],.12);
    addStaticBatch(root,shedGeo,concrete,`machine-hall-bay-rib-batch-${i}`,
      Array.from({length:5},(_,rib)=>({sourceName:`machine-hall-bay-rib-${i}-${rib}`,
        position:[x-3.2+rib*1.6,4.2,z+.27] as const,scale:[.12,7.25,.035] as const,rotation:[0,.12,0] as const})));
    addBox(root,shedGeo,warm,`machine-hall-bay-safety-stripe-${i}`,[x,8.35,z+.29],[8.2,.16,.05],.12);
  }
  addBox(root,shedGeo,steel,'machine-hall-signboard',[hallCenter.x,11.2,hallCenter.z+17.35],[14,2.2,.34],.12);
  addBox(root,shedGeo,warm,'machine-hall-sign-rule',[hallCenter.x,11.2,hallCenter.z+17.55],[8,.10,.04],.12);
  const tankGeo = new THREE.CylinderGeometry(4.1,4.1,15,18,1);
  const tankRoofGeo = new THREE.ConeGeometry(4.25,2.6,18,1);
  const tankBandGeo = new THREE.TorusGeometry(4.08,.085,6,24);
  for(const [i,x] of [142,156,170].entries()){
    const z=-108, tank=new THREE.Mesh(tankGeo,i===1?steel:concrete); tank.name=`salt-tank-${i+1}`;
    tank.position.set(x,7.5,z); tank.castShadow=true; root.add(tank);
    const roof=new THREE.Mesh(tankRoofGeo,shedPaint); roof.name=`salt-tank-roof-${i+1}`;
    roof.position.set(x,16.3,z); roof.castShadow=true; root.add(roof);
    addStaticBatch(root,tankBandGeo,steel,`salt-tank-${i+1}-band-detail-batch`,[4.2,8.3,12.4].map((y,j)=>({
      sourceName:`salt-tank-${i+1}-band-${j+1}`,position:[x,y,z] as const,rotation:[Math.PI/2,0,0] as const,
    })));
    for(const side of [-1,1]) addBox(root,shedGeo,steel,`salt-tank-${i+1}-ladder-rail-${side}`,
      [x+side*.34,7.5,z+4.14],[.075,8.4,.10]);
    addStaticBatch(root,shedGeo,steel,`salt-tank-${i+1}-ladder-rungs-batch`,Array.from({length:10},(_,rung)=>({
      sourceName:`salt-tank-${i+1}-ladder-rung-${rung}`,position:[x,3.5+rung*.82,z+4.18] as const,scale:[.72,.055,.06] as const,
    })));
  }
  // Repeated bollards and lamps share geometry/material; modest count protects draw budget.
  const lampGeo = new THREE.CylinderGeometry(0.12, 0.2, 10, 8);
  const lampHeadGeo = new THREE.BoxGeometry(0.9, 0.32, 0.8);
  for (let i = 0; i < 12; i++) {
    const z = -70 + i * 14;
    const pole = new THREE.Mesh(lampGeo, steel); pole.name = `quay-lamp-pole-${i}`; pole.position.set(162, 5, z); pole.castShadow = true; root.add(pole);
    const head = new THREE.Mesh(lampHeadGeo, warm); head.name = `quay-lamp-head-${i}`; head.position.set(162, 10.1, z); root.add(head);
  }
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  for(let partition=0;partition<2;partition++) addStaticBatch(root,wallGeo,concrete,`quay-wall-batch-${partition}`,
    Array.from({length:7},(_,offset)=>{const i=partition*7+offset;return {
      sourceName:`quay-wall-${i}`,position:[210+i*6,1.6,7] as const,scale:[5.8,3.2,1.2] as const,
    };}));
  // Distant ridge silhouettes are muted, layered shapes, not a flat backdrop.
  const ridgeMat = mat('distant-ridge', '#657477', 1);
  const ridgeShapes = [
    [[-150,0],[-132,11],[-111,20],[-88,26],[-65,29],[-43,26],[-22,22],[0,31],[23,35],[47,33],[68,26],[91,23],[112,19],[132,12],[150,0]],
    [[-145,0],[-124,9],[-102,15],[-81,19],[-57,24],[-33,25],[-11,22],[12,27],[34,30],[57,27],[81,22],[103,17],[126,12],[145,0]],
    [[-139,0],[-118,8],[-97,13],[-75,18],[-53,20],[-31,18],[-8,21],[14,24],[36,25],[60,23],[82,18],[104,15],[123,10],[139,0]],
  ];
  for (const [i, profile] of ridgeShapes.entries()) {
    const curve = new THREE.SplineCurve(profile.map(([x,y])=>new THREE.Vector2(x!,y!)));
    const smooth = curve.getPoints(120);
    const shape = new THREE.Shape(); shape.moveTo(smooth[0]!.x,smooth[0]!.y);
    for (const point of smooth.slice(1)) shape.lineTo(point.x,point.y);
    shape.lineTo(profile.at(-1)![0]!, -16); shape.lineTo(profile[0]![0]!, -16); shape.closePath();
    const ridgeMaterial = ridgeMat.clone(); ridgeMaterial.color.set(i === 1 ? '#748184' : '#657477');
    const ridge = new THREE.Mesh(new THREE.ShapeGeometry(shape), ridgeMaterial);
    ridge.name = `ridge-silhouette-${i}`; ridge.position.set(-15 + i*18, 0, -215 - i*28); ridge.castShadow = false; root.add(ridge);
  }
  return root;
}

export function sampleHarborRoute(): readonly THREE.Vector3[] { return createHarborPoints(); }

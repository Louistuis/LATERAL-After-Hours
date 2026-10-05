import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRunController } from '../../src/events/run-controller';
import { VEHICLE_PHYSICS_VERSION } from '../../src/physics';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs';
import { buildHarborApronCollision, buildHarborCurbCollisions, buildHarborGuardrailCollisions, buildHarborRoute, buildHarborWaterCollision, sampleHarborRoute } from '../../src/world/route-data';
import { createArcS } from '../../assets-source/3d/arc-s-source';
import { createHarborSource } from '../../assets-source/3d/harbor-source';
import { CAR_ASSETS, WHEEL_ANCHOR_Y, applyHarborTextureMaps, apronVertexTint, createCarPresentation, fitCarRoot, isHarborCameraCollisionProp } from '../../src/world/index';

describe('Harbor Works authored route', () => {
  const { route, collision } = buildHarborRoute();

  it('has a connected route length, spawn-aligned centerline and ordered finish gate', () => {
    expect(route.lengthM).toBeGreaterThan(700);
    expect(route.lengthM).toBeLessThan(900);
    expect(route.version).toBe('1.0.3');
    expect(route.centerline[0]!.x).toBeCloseTo(route.spawn.position.x, 3);
    expect(route.centerline[0]!.z).toBeCloseTo(route.spawn.position.z, 3);
    expect(route.widthM).toBe(13.5);
    expect(route.checkpoints).toHaveLength(8);
    const points=sampleHarborRoute(), offsets=[8,43,78,112,147,182,217,252], spawnIndex=Math.floor(points.length/2);
    for(let i=0;i<offsets.length;i++){
      const expected=points[(spawnIndex+offsets[i]!)%points.length]!, gate=route.checkpoints[i]!;
      expect(gate.center.x).toBeCloseTo(expected.x,3);
      expect(gate.center.y).toBeCloseTo(expected.y+.12,3);
      expect(gate.center.z).toBeCloseTo(expected.z,3);
    }
    let finishProgress=0;
    for(let i=0;i<252;i++)finishProgress+=points[(spawnIndex+i)%points.length]!.distanceTo(points[(spawnIndex+i+1)%points.length]!);
    expect(finishProgress/route.lengthM).toBeGreaterThan(.98);
    expect(route.clippingZones).toEqual([{
      id:'HW01-CLIP-WEST-01',progressM:107,radiusM:6,preferredOffsetM:3.8,lateralToleranceM:.7,bonusFactor:1.2,
    }]);
    expect(route.clippingZones!.every(zone=>(zone.progressM<310||zone.progressM>410)&&zone.bonusFactor>=1&&zone.bonusFactor<=1.5)).toBe(true);
    expect(route.checkpoints.filter((gate) => gate.finish)).toEqual([route.checkpoints.at(-1)]);
    expect(Math.abs(route.spawn.rotation.x) + Math.abs(route.spawn.rotation.z)).toBe(0);
    const q = route.spawn.rotation;
    expect(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).toBeCloseTo(1, 6);
  });

  it('builds upward-facing drivable road triangles and a separate non-drivable apron', () => {
    expect(collision.drivableRoad).toBe(true);
    expect(collision.surfaceId).toBe('road:harbor:hw01');
    expect(collision.indices.length % 3).toBe(0);
    for (let i = 0; i < collision.indices.length; i += 3) {
      const a = collision.vertices[collision.indices[i]!]!, b = collision.vertices[collision.indices[i + 1]!]!, c = collision.vertices[collision.indices[i + 2]!]!;
      const ab = { x: b.x-a.x, y: b.y-a.y, z: b.z-a.z }, ac = { x: c.x-a.x, y: c.y-a.y, z: c.z-a.z };
      expect(ab.z * ac.x - ab.x * ac.z).toBeGreaterThan(0);
    }
    const apron = buildHarborApronCollision();
    expect(apron.drivableRoad).toBe(false);
    expect(apron.surfaceId).toBe('ground:harbor:apron');
    const water = buildHarborWaterCollision();
    expect(water.drivableRoad).toBe(false);
    expect(water.surfaceId).toBe('water:harbor:basin');
    expect(water.vertices.every((v) => v.y === -.62)).toBe(true);
    const curbs = buildHarborCurbCollisions();
    expect(curbs.map((curb) => curb.surfaceId)).toEqual(['curb:harbor:hw01:left','curb:harbor:hw01:right']);
    expect(curbs.every((curb) => curb.drivableRoad === false && curb.indices.length === 3072 /* curb band + run-off shoulder to the rail */)).toBe(true);
    const barriers=buildHarborGuardrailCollisions();
    expect(barriers.map((barrier)=>barrier.surfaceId)).toEqual(['barrier:harbor:hw01:left','barrier:harbor:hw01:right']);
    expect(barriers.every((barrier)=>barrier.role==='obstacle'&&barrier.drivableRoad===false&&barrier.indices.length%3===0)).toBe(true);
    expect(barriers.every((barrier)=>barrier.indices.length>12_000)).toBe(true);
    for (let i=0;i<apron.vertices.length;i+=4) {
      const tile=apron.vertices.slice(i,i+4);
      const minX=Math.min(...tile.map((v)=>v.x)), maxX=Math.max(...tile.map((v)=>v.x));
      const minZ=Math.min(...tile.map((v)=>v.z)), maxZ=Math.max(...tile.map((v)=>v.z));
      expect(maxX<=137 || minX>=229 || maxZ<=32 || minZ>=104).toBe(true);
    }
  });

  it('places road-facing loading doors and low guardrails in the authored Harbor scene', () => {
    const harbor=createHarborSource();
    for(const side of ['left','right']){
      const rail=harbor.getObjectByName(`road-hw01-guardrail-${side}`);
      expect(rail).toBeInstanceOf(THREE.Mesh);
      expect((rail as THREE.Mesh).geometry.getAttribute('position').count).toBeGreaterThan(10_000);
    }
    for(let i=0;i<4;i++){
      const door=harbor.getObjectByName(`shed-road-door-${i}`);
      expect(door).toBeInstanceOf(THREE.Mesh);
      const yaw=-.08,localX=(door!.position.x+180-15.5*Math.sin(yaw))/Math.cos(yaw);
      const wallZ=30-localX*Math.sin(yaw)+15.5*Math.cos(yaw);
      expect(Math.abs((door!.position.z-.12)-wallZ)).toBeLessThan(.002);
      expect(harbor.getObjectByName(`shed-road-door-header-${i}`)).toBeTruthy();
    }
    harbor.traverse((node)=>{if(node instanceof THREE.Mesh){node.geometry.dispose();for(const material of Array.isArray(node.material)?node.material:[node.material])material.dispose();}});
  });

  it('constructs an event run and accepts the first gate in the required direction', () => {
    const run = createRunController({
      eventId: 'test-hw01', routeId: route.id, mode: 'drift-attack', rulesVersion: 'test',
      carId: 'CAR-01', routeVersion: route.version, physicsVersion: VEHICLE_PHYSICS_VERSION,
      tuneHash: 'test', checkpoints: route.checkpoints,
      maximumGateStepM: 30,
    }, () => 'test-run');
    expect(run.prepare().expectedCheckpointId).toBe(route.checkpoints[0]!.id);
    run.startCountdown(); run.activate();
    const gate = route.checkpoints[0]!;
    const before = { x: gate.center.x - gate.forward.x, y: gate.center.y - gate.forward.y, z: gate.center.z - gate.forward.z };
    const after = { x: gate.center.x + gate.forward.x, y: gate.center.y + gate.forward.y, z: gate.center.z + gate.forward.z };
    expect(run.updateCheckpoints(before, after).acceptedIds).toEqual([gate.id]);
    expect(run.status().expectedCheckpointId).toBe(route.checkpoints[1]!.id);
  });
});

describe('mapped apron tint', () => {
  it('keeps vertex modulation neutral and bounded so concrete map supplies albedo', () => {
    for(let x=-300;x<=300;x+=13)for(let z=-240;z<=240;z+=17){
      const tint=apronVertexTint(x,z);
      expect(tint).toBeGreaterThanOrEqual(.88);
      expect(tint).toBeLessThanOrEqual(1.04);
    }
  });
  it('marks only large solid authored Harbor props for camera collision',()=>{
    expect(isHarborCameraCollisionProp('loading-shed-main')).toBe(true);
    expect(isHarborCameraCollisionProp('east-quay-machine-hall')).toBe(true);
    expect(isHarborCameraCollisionProp('salt-tank-1')).toBe(true);
    for(const name of ['road-hw01-asphalt','inner-basin-water','road-hw01-guardrail-left','asphalt-repair-patch-0','shed-road-door-0'])
      expect(isHarborCameraCollisionProp(name)).toBe(false);
  });
});

describe('ARC-S authored profile normals and scale', () => {
  it('faces the shell outward and places wheel anchors on the physics dimensions', () => {
    const car = createArcS();
    const shell = car.getObjectByName('arc-s-profile-shell');
    expect(shell).toBeInstanceOf(THREE.Mesh);
    if (!(shell instanceof THREE.Mesh)) throw new Error('ARC-S shell mesh is missing');
    const normals = shell.geometry.getAttribute('normal');
    const ring = 8;
    const hoodSection=4,sideSection=6;
    expect(normals.getY(hoodSection * ring + 3)).toBeGreaterThan(.7);
    expect(normals.getX(sideSection * ring)).toBeLessThan(-.4);
    expect(normals.getX(sideSection * ring + 6)).toBeGreaterThan(.4);
    expect(shell.position.y).toBeCloseTo(-.30, 6);
    expect(shell.geometry.boundingBox).toBeTruthy();
    expect(shell.geometry.boundingBox!.min.y + shell.position.y).toBeGreaterThan(-.51);
    expect(car.getObjectByName('body')!.position.y).toBe(0);
    expect(car.getObjectByName('wheel-fl')!.position.x).toBeCloseTo(-.775, 3);
    expect(car.getObjectByName('wheel-fr')!.position.x).toBeCloseTo(.775, 3);
    expect(car.getObjectByName('wheel-fl')!.position.z).toBeCloseTo(-1.24, 3);
    expect(car.getObjectByName('wheel-rl')!.position.z).toBeCloseTo(1.24, 3);
    expect(car.getObjectByName('body')!.getObjectByName('brake-lights')).toBeTruthy();
    expect(car.getObjectByName('body')!.getObjectByName('reverse-lights')).toBeTruthy();
    expect(car.getObjectByName('body')!.getObjectByName('profile-front-closure')).toBeInstanceOf(THREE.Mesh);
    expect(car.getObjectByName('body')!.getObjectByName('profile-rear-closure')).toBeInstanceOf(THREE.Mesh);
    expect(car.getObjectByName('body')!.getObjectByName('roof-side-rail-1')).toBeTruthy();
    expect(car.getObjectByName('body')!.getObjectByName('side-front-glazing-1')).toBeInstanceOf(THREE.Mesh);
    expect(car.getObjectByName('body')!.getObjectByName('wheel-arch-lip-1--1.24')).toBeTruthy();
    car.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.geometry.dispose();
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
      }
    });
  });

  it('keeps rear hatch glazing visible to an elevated chase view through a real shell aperture', () => {
    const car = createArcS();
    car.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 1, 3), new THREE.Vector3(0, .56, 1.25).sub(new THREE.Vector3(0, 1, 3)).normalize());
    const hits = ray.intersectObject(car, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.object.name).toBe('rear-hatch-glazing');
    const windshieldRay=new THREE.Raycaster(new THREE.Vector3(0,1,-1.2),new THREE.Vector3(0,.65,-.45).sub(new THREE.Vector3(0,1,-1.2)).normalize());
    expect(windshieldRay.intersectObject(car,true)[0]!.object.name).toBe('windscreen-glazing');
    const sideRay=new THREE.Raycaster(new THREE.Vector3(1.2,.45,-.2),new THREE.Vector3(-1,0,0));
    expect(sideRay.intersectObject(car,true)[0]!.object.name).toBe('side-front-glazing-1');
    const shell = car.getObjectByName('arc-s-profile-shell');
    expect(shell).toBeInstanceOf(THREE.Mesh);
    if (shell instanceof THREE.Mesh) {
      const p = shell.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) expect(Number.isFinite(p.getY(i))).toBe(true);
      const archRay=new THREE.Raycaster(new THREE.Vector3(1.1,0,1.24),new THREE.Vector3(-1,0,0));
      expect(archRay.intersectObject(shell,false)).toHaveLength(0);
    }
    const roof=car.getObjectByName('liftback-roof');
    expect(roof).toBeInstanceOf(THREE.Mesh);
    if(roof instanceof THREE.Mesh)expect((roof.geometry as THREE.BoxGeometry).parameters.depth).toBeCloseTo(.72,4);
    car.traverse((node) => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.dispose(); } });
  });

  it('uses small irregular road-following repair polygons with upward normals', () => {
    const harbor=createHarborSource();
    const patches:THREE.Mesh[]=[];
    const routeSamples=sampleHarborRoute();
    harbor.traverse((node)=>{if(node instanceof THREE.Mesh&&node.name.startsWith('asphalt-repair-patch-'))patches.push(node);});
    expect(patches).toHaveLength(11);
    for(const patch of patches){
      const positions=patch.geometry.getAttribute('position'), normals=patch.geometry.getAttribute('normal');
      const earlyRepair=patch.name==='asphalt-repair-patch-7';
      expect(positions.count).toBe(earlyRepair?11:8);
      expect(patch.geometry.getAttribute('uv').count).toBe(positions.count);
      for(let i=0;i<normals.count;i++) expect(normals.getY(i)).toBeGreaterThan(.9);
      if(earlyRepair){
        const colors=patch.geometry.getAttribute('color');
        expect(colors.count).toBe(positions.count);
        expect(patch.material).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect((patch.material as THREE.MeshStandardMaterial).name).toBe('asphalt-repair');
        for(let i=0;i<positions.count;i++){
          const x=positions.getX(i),z=positions.getZ(i);
          let nearest=Number.POSITIVE_INFINITY,expectedY=0;
          for(let j=0;j<routeSamples.length;j++){
            const a=routeSamples[j]!,b=routeSamples[(j+1)%routeSamples.length]!;
            const dx=b.x-a.x,dz=b.z-a.z,t=THREE.MathUtils.clamp(((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz),0,1);
            const px=a.x+dx*t,pz=a.z+dz*t,d=(x-px)**2+(z-pz)**2;
            if(d<nearest){nearest=d;expectedY=a.y+(b.y-a.y)*t+.0815;}
          }
          expect(positions.getY(i)).toBeCloseTo(expectedY,3);
          expect(colors.getX(i)).toBeCloseTo(.94,5);
        }
      }
      const box=new THREE.Box3().setFromBufferAttribute(positions as THREE.BufferAttribute);
      expect(box.getSize(new THREE.Vector3()).x).toBeLessThan(3.5);
      expect(box.getSize(new THREE.Vector3()).z).toBeLessThan(3.5);
    }
    harbor.traverse((node)=>{if(node instanceof THREE.Mesh){node.geometry.dispose();for(const material of Array.isArray(node.material)?node.material:[node.material])material.dispose();}});
  });

  it('exports broad layered ridge silhouettes with enough profile samples to avoid angular peaks', () => {
    const harbor=createHarborSource();
    const ridges:THREE.Mesh[]=[];
    harbor.traverse((node)=>{if(node instanceof THREE.Mesh&&node.name.startsWith('ridge-silhouette-'))ridges.push(node);});
    expect(ridges).toHaveLength(3);
    for(const ridge of ridges) expect(ridge.geometry.getAttribute('position').count).toBeGreaterThan(120);
    harbor.traverse((node)=>{if(node instanceof THREE.Mesh){node.geometry.dispose();for(const material of Array.isArray(node.material)?node.material:[node.material])material.dispose();}});
  });
});

describe('reproducible runtime asset exports', () => {
  it('keeps authored albedo maps untinted instead of multiplying dark source material colors', () => {
    const root=new THREE.Group();
    const slots=['road-asphalt','asphalt-repair','concrete-weathered','curb-painted-concrete','steel-oxidized','loading-door','shed-deep-teal'];
    for(const name of slots){const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial({name,color:'#343a3d'}));root.add(mesh);}
    const textures:Record<string,THREE.Texture>=Object.fromEntries(
      ['harbor-asphalt','harbor-concrete','harbor-curb','harbor-steel','harbor-shed-paint'].map(name=>[name,new THREE.Texture()]),
    );
    applyHarborTextureMaps(root,textures);
    root.traverse(node=>{if(node instanceof THREE.Mesh&&node.material instanceof THREE.MeshStandardMaterial){
      expect(node.material.color.getHexString()).toBe('ffffff'); expect(node.material.map).toBeTruthy();
    }});
    const door = root.children.find((node)=>node instanceof THREE.Mesh && node.material instanceof THREE.MeshStandardMaterial && node.material.name==='loading-door') as THREE.Mesh;
    expect((door.material as THREE.MeshStandardMaterial).map).toBe(textures['harbor-concrete']);
    Object.values(textures).forEach(texture=>texture.dispose());
  });

  it.skipIf(!existsSync('public/assets/cars/challenger.glb'))('verifies every asset-manifest hash and the exported Harbor world (car GLBs: tests/world/owner-cars.test.ts)', async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(resolve(root, 'public/assets/asset-manifest.json'), 'utf8')) as {
      assets: readonly { path: string; sha256: string; bytes: number }[];
      sourceHashes: Readonly<Record<string, string>>;
    };
    const exportedWorld=JSON.parse(await readFile(resolve(root,'public/assets/world/hw-01-built.json'),'utf8')) as {
      route:{version:string;checkpoints:readonly {finish?:boolean}[]};
      collisionMeshes:readonly {surfaceId:string;role?:string;drivableRoad?:boolean}[];
    };
    expect(exportedWorld.route.version).toBe('1.0.3');
    expect(exportedWorld.collisionMeshes.filter((mesh)=>mesh.role==='obstacle').map((mesh)=>mesh.surfaceId)).toEqual([
      'barrier:harbor:hw01:left','barrier:harbor:hw01:right',
    ]);
    expect(exportedWorld.route.checkpoints.at(-1)?.finish).toBe(true);
    for (const asset of manifest.assets) {
      const bytes = await readFile(resolve(root, asset.path));
      expect(bytes.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    }
    for(const name of ['harbor-asphalt','harbor-concrete','harbor-curb','harbor-steel','harbor-shed-paint']){
      const path=`public/assets/materials/${name}.png`,asset=manifest.assets.find(item=>item.path===path);
      expect(asset).toBeTruthy();
      const png=await readFile(resolve(root,path));
      expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
      expect(png.readUInt32BE(16)).toBe(256); expect(png.readUInt32BE(20)).toBe(256);
    }
    for (const retired of ['arc-s', 'arc-s-lod1', 'vela-gt', 'vela-gt-lod1']) expect(manifest.assets.some((asset) => asset.path.endsWith(`/${retired}.glb`))).toBe(false);
  });
});

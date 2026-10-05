import * as THREE from 'three';

export const ARC_S_PROFILE = {
  wheelbaseM: 2.48, trackM: 1.55, wheelRadiusM: 0.31,
  sections: [
    { z: -1.69, halfWidth: .70, lowerY: -.12, shoulderY: .21, crownY: .34 },
    { z: -1.58, halfWidth: .76, lowerY: -.08, shoulderY: .29, crownY: .39 },
    { z: -1.45, halfWidth: .81, lowerY: .05, shoulderY: .37, crownY: .45 },
    { z: -1.24, halfWidth: .84, lowerY: .23, shoulderY: .44, crownY: .48 },
    { z: -1.03, halfWidth: .85, lowerY: .05, shoulderY: .46, crownY: .49 },
    { z: -.82, halfWidth: .84, lowerY: -.08, shoulderY: .46, crownY: .49 },
    { z: -.48, halfWidth: .84, lowerY: -.12, shoulderY: .46, crownY: .49 },
    { z: .43, halfWidth: .86, lowerY: -.12, shoulderY: .46, crownY: .49 },
    { z: .82, halfWidth: .85, lowerY: -.08, shoulderY: .44, crownY: .47 },
    { z: 1.03, halfWidth: .84, lowerY: .05, shoulderY: .42, crownY: .46 },
    { z: 1.24, halfWidth: .83, lowerY: .23, shoulderY: .40, crownY: .44 },
    { z: 1.45, halfWidth: .80, lowerY: .05, shoulderY: .36, crownY: .41 },
    { z: 1.58, halfWidth: .75, lowerY: -.08, shoulderY: .29, crownY: .36 },
    { z: 1.72, halfWidth: .69, lowerY: -.12, shoulderY: .23, crownY: .31 },
  ],
} as const;

const material = (name: string, color: string, roughness: number, metalness = 0): THREE.MeshStandardMaterial => {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness }); m.name = name; return m;
};

function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, name: string,
  position: readonly [number, number, number] = [0, 0, 0], rotation: readonly [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const result = new THREE.Mesh(geometry, mat); result.name = name;
  result.position.set(...position); result.rotation.set(...rotation); result.castShadow = true; result.receiveShadow = true;
  parent.add(result); return result;
}

function bodyShell(): THREE.BufferGeometry {
  const pos: number[] = [], indices: number[] = [];
  for (const s of ARC_S_PROFILE.sections) {
    // Four transverse stations: sill, shoulder, crown and center. The profile creates
    // a tapered liftback with explicit hood, beltline, shoulder and lower rocker volume.
    const points = [
      [-s.halfWidth, s.lowerY], [-s.halfWidth * .98, s.shoulderY],
      [-s.halfWidth * .72, s.crownY], [0, s.crownY + .035],
      [s.halfWidth * .72, s.crownY], [s.halfWidth * .98, s.shoulderY],
      [s.halfWidth, s.lowerY], [0, s.lowerY - .045],
    ];
    for (const [x, y] of points) pos.push(x, y, s.z);
  }
  const ring = 8;
  for (let i = 0; i < ARC_S_PROFILE.sections.length; i++) {
    const ni = (i + 1) % ARC_S_PROFILE.sections.length;
    // Not closed along z; the two ends receive separately modeled bumpers.
    if (ni === 0) continue;
    const firstZ=ARC_S_PROFILE.sections[i]!.z,lastZ=ARC_S_PROFILE.sections[ni]!.z;
    const glazingAperture=firstZ>=-.82&&lastZ<=1.58;
    const wheelArchAperture=(j:number):boolean=>(j===0||j===5)&&[-1.24,1.24].some((axleZ)=>Math.abs((firstZ+lastZ)/2-axleZ)<.42);
    for (let j = 0; j < ring; j++) {
      // Clear a continuous canopy opening for distinct transparent glass/opaque roof.
      // Side wall panels at the axle stations are removed for actual tire/fender cutouts.
      if ((glazingAperture && (j === 2 || j === 3)) || wheelArchAperture(j)) continue;
      const a = i * ring + j, b = i * ring + (j + 1) % ring;
      const c = ni * ring + j, d = ni * ring + (j + 1) % ring;
      // Ring walk is front-to-rear while each section walks left-to-right;
      // reverse the old winding so the outer shell normals face out/up.
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(indices); g.computeVertexNormals(); return g;
}

function bodyEndCap(section: typeof ARC_S_PROFILE.sections[number]): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const points = [
    [-section.halfWidth, section.lowerY], [-section.halfWidth * .98, section.shoulderY],
    [-section.halfWidth * .72, section.crownY], [0, section.crownY + .035],
    [section.halfWidth * .72, section.crownY], [section.halfWidth * .98, section.shoulderY],
    [section.halfWidth, section.lowerY], [0, section.lowerY - .045],
  ];
  points.forEach(([x,y], index) => index === 0 ? shape.moveTo(x!,y!) : shape.lineTo(x!,y!));
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function addTube(parent: THREE.Object3D, points: THREE.Vector3[], radius: number, mat: THREE.Material, name: string): void {
  const curve = new THREE.CatmullRomCurve3(points);
  mesh(parent, new THREE.TubeGeometry(curve, Math.max(8, points.length * 3), radius, 5, false), mat, name);
}

export interface ArcBuildOptions { readonly lod?: 0 | 1; }

/** Original profile-authored ARC-S: compact two-door liftback with distinct roof/glass and detailed rolling stock. */
export function createArcS(options: ArcBuildOptions = {}): THREE.Group {
  const lod = options.lod ?? 0;
  const root = new THREE.Group(); root.name = 'ARC-S';
  const body = new THREE.Group(); body.name = 'body'; root.add(body);
  const paint = new THREE.MeshPhysicalMaterial({ name: 'paint', color: '#435e69', roughness: .29, metalness: .2, clearcoat: .68, clearcoatRoughness: .28 });
  const glass = material('glass', '#182a31', .18, .3); glass.transparent = true; glass.opacity = .88; glass.side = THREE.DoubleSide;
  const rubber = material('rubber', '#171a1b', .86);
  const metal = material('metal', '#87918e', .27, .82);
  const trim = material('trim', '#1e2628', .48, .25);
  const lampMat = material('lamp', '#eaf3eb', .18, .1); lampMat.emissive.set('#cfe9ff'); lampMat.emissiveIntensity = .65;
  const redMat = material('lamp-red', '#7b1717', .24); redMat.emissive.set('#4f0808'); redMat.emissiveIntensity = .2;
  const brakeMat = material('lamp-brake', '#ff2415', .22); brakeMat.emissive.set('#ff1708'); brakeMat.emissiveIntensity = .25;
  const reverseMat = material('lamp-reverse', '#e6efe7', .2); reverseMat.emissive.set('#e3f4ff'); reverseMat.emissiveIntensity = .18;
  const cabin = material('interior', '#292e30', .78);
  const shell = mesh(body, bodyShell(), paint, 'arc-s-profile-shell'); shell.geometry.computeBoundingBox();
  const capPaint = paint.clone(); capPaint.side = THREE.DoubleSide;
  for (const [end, section] of [['front', ARC_S_PROFILE.sections[0]!], ['rear', ARC_S_PROFILE.sections.at(-1)!]] as const) {
    mesh(body, bodyEndCap(section), capPaint, `profile-${end}-closure`, [0,0,section.z + (end === 'rear' ? .002 : -.002)]);
  }

  // A short opaque roof cap separates the windshield and rear hatch glazing.
  mesh(body,new THREE.BoxGeometry(1.12,.075,.72),paint,'liftback-roof',[0,.91,.21]);
  const hatchGlassGeo = new THREE.BufferGeometry();
  hatchGlassGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -.53,.92,.56, .53,.92,.56, -.54,.423,1.53, .54,.423,1.53,
  ],3));
  hatchGlassGeo.setIndex([0,2,1,1,2,3]); hatchGlassGeo.computeVertexNormals();
  mesh(body,hatchGlassGeo,glass,'rear-hatch-glazing');
  addTube(body,[new THREE.Vector3(-.53,.92,.55),new THREE.Vector3(-.54,.423,1.53),new THREE.Vector3(.54,.423,1.53),new THREE.Vector3(.53,.92,.55),new THREE.Vector3(-.53,.92,.55)],.013,trim,'rear-glass-surround');
  for(let i=1;i<=4;i++){
    const t=i/5,y=.92-.497*t,z=.56+.97*t,x=.53+.01*t;
    addTube(body,[new THREE.Vector3(-x,y,z),new THREE.Vector3(x,y,z)],.003,metal,`rear-window-defroster-${i}`);
  }
  mesh(body,new THREE.BoxGeometry(.64,.018,.028),trim,'rear-window-wiper',[0,.51,1.36],[0,0,-.15]);
  mesh(body,new THREE.BoxGeometry(1.18,.045,.10),paint,'liftback-spoiler',[0,.39,1.49]);
  const windscreenGeo = new THREE.BufferGeometry();
  windscreenGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -.66,.46,-.82, .66,.46,-.82, -.53,.92,-.15, .53,.92,-.15,
  ], 3));
  windscreenGeo.setIndex([0,1,2,1,3,2]); windscreenGeo.computeVertexNormals();
  mesh(body, windscreenGeo, glass, 'windscreen-glazing');
  for (const side of [-1, 1]) {
    const frontSideWindow=new THREE.BufferGeometry();
    frontSideWindow.setAttribute('position',new THREE.Float32BufferAttribute([
      side*.84,.44,-.60, side*.84,.44,.08, side*.56,.79,.08, side*.60,.79,-.40,
    ],3));frontSideWindow.setIndex([0,1,2,0,2,3]);frontSideWindow.computeVertexNormals();
    mesh(body,frontSideWindow,glass,`side-front-glazing-${side}`);
    const rearSideWindow=new THREE.BufferGeometry();
    rearSideWindow.setAttribute('position',new THREE.Float32BufferAttribute([
      side*.84,.43,.18, side*.84,.43,.66, side*.56,.78,.56, side*.56,.79,.18,
    ],3));rearSideWindow.setIndex([0,1,2,0,2,3]);rearSideWindow.computeVertexNormals();
    mesh(body,rearSideWindow,glass,`side-rear-glazing-${side}`);
    addTube(body,[new THREE.Vector3(side*.84,.44,-.60),new THREE.Vector3(side*.60,.79,-.40),new THREE.Vector3(side*.56,.92,-.15)],.04,trim,`roof-a-pillar-${side}`);
    addTube(body,[new THREE.Vector3(side*.56,.92,-.15),new THREE.Vector3(side*.56,.92,.55)],.035,trim,`roof-side-rail-${side}`);
    addTube(body,[new THREE.Vector3(side*.56,.78,.56),new THREE.Vector3(side*.56,.92,.55),new THREE.Vector3(side*.54,.423,1.53)],.035,trim,`roof-c-pillar-${side}`);
    addTube(body,[new THREE.Vector3(side*.84,.43,.12),new THREE.Vector3(side*.56,.79,.12)],.026,trim,`side-b-pillar-${side}`);
    // Original fine panel seams follow the door and hood; no heavy black cartoon outline.
    addTube(body, [new THREE.Vector3(side*.805,.14,-.68), new THREE.Vector3(side*.83,.16,-.24), new THREE.Vector3(side*.84,.16,.70), new THREE.Vector3(side*.79,.14,1.20)], .008, trim, `door-panel-seam-${side}`);
    mesh(body, new THREE.BoxGeometry(.035,.045,.34), metal, `flush-door-handle-${side}`, [side*.842,.29,.22]);
    mesh(body, new THREE.BoxGeometry(.075,.13,.48), trim, `side-mirror-${side}`, [side*.87,.39,-.58], [0,side*.12,side*.08]);
    for (const axleZ of [-1.24, 1.24]) {
      const arch = Array.from({ length: 19 }, (_, i) => {
        const angle = i * Math.PI / 18;
        return new THREE.Vector3(side*.845, -.058 + Math.sin(angle)*.385, axleZ + Math.cos(angle)*.385);
      });
      addTube(body, arch, .014, trim, `wheel-arch-lip-${side}-${axleZ}`);
    }
  }
  // Liftback and bonnet breaks catch narrow highlights without heavy dark outlines.
  addTube(body, [new THREE.Vector3(-.68,.38,.99),new THREE.Vector3(-.48,.37,1.12),new THREE.Vector3(0,.36,1.17),new THREE.Vector3(.48,.37,1.12),new THREE.Vector3(.68,.38,.99)], .009, trim, 'liftback-panel-seam');
  addTube(body, [new THREE.Vector3(-.57,.33,-1.32),new THREE.Vector3(-.34,.35,-1.43),new THREE.Vector3(0,.36,-1.46),new THREE.Vector3(.34,.35,-1.43),new THREE.Vector3(.57,.33,-1.32)], .009, trim, 'bonnet-panel-seam');
  // Fascia layers: recessed grille, lower air opening, bumper bar and front/rear lamps.
  mesh(body, new THREE.BoxGeometry(1.02,.16,.055), trim, 'front-upper-grille', [0,.015,-1.694]);
  mesh(body, new THREE.BoxGeometry(.76,.085,.058), metal, 'grille-horizontal-inlay', [0,.005,-1.726]);
  mesh(body, new THREE.BoxGeometry(1.18,.14,.09), trim, 'front-lower-intake', [0,-.115,-1.66]);
  mesh(body, new THREE.BoxGeometry(1.32,.075,.12), trim, 'front-splitter', [0,-.18,-1.62]);
  mesh(body, new THREE.BoxGeometry(1.22,.09,.07), trim, 'rear-diffuser', [0,-.16,1.66]);
  mesh(body, new THREE.BoxGeometry(1.36,.105,.11), trim, 'rear-bumper-fascia', [0,-.105,1.755]);
  mesh(body, new THREE.BoxGeometry(.37,.135,.024), metal, 'rear-registration-surround', [0,.105,1.751]);
  mesh(body, new THREE.BoxGeometry(.32,.09,.012), material('registration-plate','#c6c2b4',.72), 'rear-registration-plate', [0,.105,1.77]);
  mesh(body, new THREE.BoxGeometry(1.24,.045,.025), trim, 'rear-light-bar-trim', [0,.285,1.751]);
  const frontLamp = new THREE.Group(); frontLamp.name = 'lamp-front'; body.add(frontLamp);
  const rearLamp = new THREE.Group(); rearLamp.name = 'lamp-rear'; body.add(rearLamp);
  for (const side of [-1, 1]) {
    mesh(frontLamp, new THREE.BoxGeometry(.28,.11,.04), lampMat, `lamp-front-${side < 0 ? 'left' : 'right'}`, [side*.55,.235,-1.64]);
    mesh(frontLamp, new THREE.BoxGeometry(.12,.035,.045), trim, `front-lamp-detail-${side}`, [side*.55,.235,-1.668]);
    mesh(rearLamp, new THREE.BoxGeometry(.44,.095,.045), redMat, `lamp-rear-${side < 0 ? 'left' : 'right'}`, [side*.51,.23,1.758]);
  }
  const brakeGroup = new THREE.Group(); brakeGroup.name = 'brake-lights'; body.add(brakeGroup);
  const reverseGroup = new THREE.Group(); reverseGroup.name = 'reverse-lights'; body.add(reverseGroup);
  mesh(brakeGroup, new THREE.BoxGeometry(.70,.045,.05), brakeMat, 'brake-light-bar', [0,.30,1.76]);
  for (const side of [-1, 1]) mesh(reverseGroup, new THREE.BoxGeometry(.10,.045,.052), reverseMat, `reverse-lamp-${side}`, [side*.5,.20,1.77]);
  brakeGroup.visible = false; reverseGroup.visible = false;

  // Visible cabin silhouette: two seats, dash, steering rim and rear bench.
  mesh(body, new THREE.BoxGeometry(1.05,.20,.28), cabin, 'dashboard', [0,.47,-.48]);
  mesh(body, new THREE.BoxGeometry(1.12,.19,.35), cabin, 'rear-bench', [0,.25,.75]);
  for (const side of [-1,1]) {
    mesh(body, new THREE.BoxGeometry(.39,.34,.42), cabin, `front-seat-${side}`, [side*.30,.31,.03], [-.08,0,side*.04]);
    mesh(body, new THREE.BoxGeometry(.07,.55,.07), trim, `seat-bolster-${side}`, [side*.52,.27,.03]);
  }
  const steering = new THREE.Mesh(new THREE.TorusGeometry(.14,.018,7,20), metal); steering.name = 'steering-wheel';
  steering.position.set(-.39,.57,-.40); steering.rotation.x = Math.PI/2; body.add(steering);

  // Functional wheel groups are centered on world tire centers supplied by WheelSnapshot.
  const wheels: THREE.Group[] = [];
  const wheelRadius = ARC_S_PROFILE.wheelRadiusM;
  const tireGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, .235, lod ? 16 : 28, 1);
  const ringGeo = new THREE.RingGeometry(wheelRadius*.47, wheelRadius*.69, lod ? 16 : 28);
  const spokeDepth = lod ? .022 : .028;
  const discGeo = new THREE.CylinderGeometry(wheelRadius*.48, wheelRadius*.48, .248, lod ? 12 : 20, 1);
  for (const [index, [x,z]] of [[-.775,-1.24],[.775,-1.24],[-.775,1.24],[.775,1.24]].entries()) {
    const wheel = new THREE.Group(); wheel.name = `wheel-${['fl','fr','rl','rr'][index]}`; wheel.position.set(x,-.12,z); root.add(wheel); wheels.push(wheel);
    mesh(wheel, tireGeo, rubber, 'tire-sidewall', [0,0,0], [0,0,Math.PI/2]);
    const disc = material('brake-disc','#51595a',.48,.72);
    const styles = [
      { id: 'forged', label: 'Forged Five', count: lod ? 5 : 10, width: .027, color: metal },
      { id: 'mesh', label: 'Harbor Mesh', count: lod ? 8 : 16, width: .016, color: material('mesh-alloy','#a3aaa4',.31,.78) },
      { id: 'steel', label: 'Workshop Steel', count: lod ? 6 : 8, width: .047, color: material('steel-wheel','#737a77',.46,.72) },
    ];
    for (const style of styles) {
      const rimRoot = new THREE.Group(); rimRoot.name = `wheel-style-${style.id}`; wheel.add(rimRoot);
      mesh(rimRoot, ringGeo, style.color, `${style.id}-alloy-rim`, [0,0,0], [0,0,Math.PI/2]);
      mesh(rimRoot, discGeo, disc, 'vented-brake-disc', [0,0,0], [0,0,Math.PI/2]);
      const faceX = x < 0 ? -.126 : .126;
      const faceRing = new THREE.Mesh(ringGeo, style.color); faceRing.name = `${style.id}-outer-annulus`;
      faceRing.position.x=faceX; faceRing.rotation.y=x < 0 ? -Math.PI/2 : Math.PI/2; faceRing.castShadow=true; rimRoot.add(faceRing);
      for (let i = 0; i < style.count; i++) {
        const angle = i * Math.PI * 2 / style.count;
        mesh(rimRoot, new THREE.BoxGeometry(spokeDepth, wheelRadius*.49, style.width), style.color,
          `${style.id}-spoke-${i}`, [faceX, Math.cos(angle)*wheelRadius*.34, Math.sin(angle)*wheelRadius*.34], [angle,0,0]);
      }
      mesh(rimRoot, new THREE.CylinderGeometry(.078,.078,.035,16), trim, 'hub-cap', [faceX,0,0], [0,0,Math.PI/2]);
      rimRoot.visible = style.id === 'forged';
    }
    mesh(wheel, new THREE.BoxGeometry(.055,.14,.21), material('brake-caliper','#bd6e42',.52,.36), 'front-brake-caliper', [-.11,-.01,-.06]);
  }
  // Four distinct original paint panels are cosmetic variants; stock remains the hero color.
  const liveryGroup = new THREE.Group(); liveryGroup.name = 'livery-panels'; body.add(liveryGroup);
  const stripe = material('livery-salt-white','#e7e2d4',.4,.1);
  mesh(liveryGroup, new THREE.BoxGeometry(.16,.012,2.75), stripe, 'offset-center-stripe', [.29,.496,.03]);
  mesh(liveryGroup, new THREE.BoxGeometry(.22,.012,1.95), material('livery-copper','#c66d42',.42,.18), 'copper-rocker-accent', [-.75,-.015,.24]);
  mesh(liveryGroup, new THREE.BoxGeometry(.20,.012,1.8), material('livery-teal','#6dc0b8',.42,.12), 'harbor-wave-rocker', [.75,.0,.27]);
  mesh(liveryGroup, new THREE.BoxGeometry(.12,.012,2.65), material('livery-slate','#283337',.35,.22), 'double-slate-stripe', [-.18,.497,.03]);
  // NED-derived car must read as authored when livery is off; only non-stock graphic panels toggle.
  for (const child of [...liveryGroup.children]) child.visible = false;
  // The Rapier chassis origin is intentionally higher than the authored outer body.
  // Lower only model contents; independent world-space wheel transforms stay authoritative.
  for (const child of body.children) child.position.y -= .30;
  return root;
}

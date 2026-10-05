import * as THREE from 'three';

/** Physics-aligned source dimensions. All distances are meters; +Y is up and -Z is forward. */
export const VELA_GT_PROFILE = {
  wheelbaseM: 2.72,
  trackM: 1.64,
  wheelRadiusM: 0.33,
  wheelCenters: [
    { id: 'wheel-fl', x: -.82, y: -.12, z: -1.36 },
    { id: 'wheel-fr', x: .82, y: -.12, z: -1.36 },
    { id: 'wheel-rl', x: -.82, y: -.12, z: 1.36 },
    { id: 'wheel-rr', x: .82, y: -.12, z: 1.36 },
  ],
  lengthM: 4.34,
  rearTrackVisualM: 2.08,
} as const;

export type VelaGtSection = {
  z: number;
  halfWidth: number;
  roofHalfWidth: number;
  sillY: number;
  shoulderY: number;
  roofY: number;
};

const AXLES = [-1.36, 1.36] as const;
const GLASS_FROM_Z = -.76;
const GLASS_TO_Z = 1.5;
const PROFILE_ENDS = [-2.17, 2.17] as const;
const APERTURE_STATIONS = [
  -1.55, GLASS_FROM_Z, -.72, -.24, -.04, .08, .53, .54, .72, 1.2, GLASS_TO_Z,
] as const;

function bodySections(): VelaGtSection[] {
  const zValues = new Set<number>(PROFILE_ENDS);
  for (let i = 1; i < 30; i++) zValues.add(Number((PROFILE_ENDS[0] + (PROFILE_ENDS[1] - PROFILE_ENDS[0]) * i / 30).toFixed(4)));
  APERTURE_STATIONS.forEach((z) => zValues.add(z));
  // Dense stations follow each wheel opening so the fender edge is a curved panel boundary.
  const archStations: number[] = [];
  for (const axle of AXLES) {
    for (let step = -5; step <= 5; step++) {
      const z = Number((axle + step * .066).toFixed(4));
      zValues.add(z);
      archStations.push(z);
    }
  }
  const sorted = [...zValues].sort((a, b) => a - b);
  const mandatory = new Set<number>([...PROFILE_ENDS, ...APERTURE_STATIONS, ...archStations]);
  const stations: number[] = [];
  for (const z of sorted) {
    const previous = stations.at(-1);
    if (previous === undefined || z - previous >= .028 || mandatory.has(z)) {
      if (mandatory.has(z) && previous !== undefined && z - previous < .028 && !mandatory.has(previous)) stations.pop();
      stations.push(z);
    }
  }
  return stations.map((z): VelaGtSection => {
    const front = z < -.9;
    const rear = z > .72;
    const halfWidth = rear
      ? 1.035 - Math.min(.075, Math.abs(z - 1.36) * .13)
      : front ? .90 + .08 * Math.max(0, 1 - Math.abs(z + 1.36) / .54) : .91;
    const shoulderY = front ? .24 + .09 * Math.max(0, Math.min(1, (z + 2.17) / 1.18))
      : rear ? .34 - .08 * Math.max(0, Math.min(1, (z - .72) / 1.45)) : .34;
    const roofY = z < -.76 ? .39 + .57 * Math.max(0, Math.min(1, (z + 2.17) / 1.41))
      : z > .53 ? .96 - .55 * Math.max(0, Math.min(1, (z - .53) / .97)) : .96;
    const roofHalfWidth = z >= -.76 && z <= GLASS_TO_Z ? .69 : .70;
    let sillY = -.23;
    for (const axleZ of AXLES) {
      const dz = z - axleZ;
      const radius = .405;
      if (Math.abs(dz) < radius) {
        // Outer sill tracks the tire's upper quadrant and leaves a true wheel opening.
        const archY = VELA_GT_PROFILE.wheelCenters[0].y + Math.sqrt(radius * radius - dz * dz);
        sillY = Math.max(sillY, archY);
      }
    }
    return { z, halfWidth, roofHalfWidth, sillY, shoulderY, roofY };
  });
}

export const VELA_GT_BODY_SECTIONS: readonly VelaGtSection[] = bodySections();
const SECTIONS = VELA_GT_BODY_SECTIONS;
const RING_SIZE = 14;

function ringPoints(s: VelaGtSection): readonly (readonly [number, number])[] {
  const w = s.halfWidth;
  const rw = s.roofHalfWidth;
  const eaveY = s.roofY - .12;
  return [
    [-w, s.sillY], [-w * .99, s.shoulderY], [-w * .91, s.shoulderY + .15],
    [-rw, eaveY], [-rw * .72, s.roofY - .02], [0, s.roofY],
    [rw * .72, s.roofY - .02], [rw, eaveY], [w * .91, s.shoulderY + .15],
    [w * .99, s.shoulderY], [w, s.sillY], [w * .48, -.285], [0, -.315], [-w * .48, -.285],
  ];
}

function shellWindowPanel(j: number, z0: number, z1: number): boolean {
  const sideWindow = z0 >= GLASS_FROM_Z && z1 <= GLASS_TO_Z;
  // Side panes use real hull openings; the sloped glass planes close these sections.
  if (sideWindow && (j === 2 || j === 7)) return true;
  // Separate windshield, roof and rear glass instead of one translucent wedge.
  return z0 >= -1.55 && z1 <= -.24 && j >= 3 && j <= 6
    || z0 >= .53 && z1 <= 1.5 && j >= 3 && j <= 6;
}

function closedShellGeometry(lowDetail = false): THREE.BufferGeometry {
  const sections = lowDetail
    ? SECTIONS.filter((section, index) => index % 2 === 0
      || APERTURE_STATIONS.includes(section.z as (typeof APERTURE_STATIONS)[number])
      || AXLES.some((axle) => Math.abs(section.z - axle) <= .405))
    : SECTIONS;
  const positions: number[] = [];
  for (const s of sections) for (const [x, y] of ringPoints(s)) positions.push(x, y, s.z);
  const indices: number[] = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const z0 = sections[i]!.z, z1 = sections[i + 1]!.z;
    for (let j = 0; j < RING_SIZE; j++) {
      if (shellWindowPanel(j, z0, z1)) continue;
      const a = i * RING_SIZE + j;
      const b = i * RING_SIZE + (j + 1) % RING_SIZE;
      const c = (i + 1) * RING_SIZE + j;
      const d = (i + 1) * RING_SIZE + (j + 1) % RING_SIZE;
      // Section progression is +Z; this order gives +Y roof and outward side normals.
      indices.push(a, c, b, b, c, d);
    }
  }
  const appendCap = (sectionIndex: number, reverse: boolean): void => {
    const center = positions.length / 3;
    positions.push(0, .12, sections[sectionIndex]!.z);
    const start = sectionIndex * RING_SIZE;
    for (let j = 0; j < RING_SIZE; j++) {
      const next = (j + 1) % RING_SIZE;
      if (reverse) indices.push(center, start + next, start + j);
      else indices.push(center, start + j, start + next);
    }
  };
  appendCap(0, false);
  appendCap(sections.length - 1, true);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function standard(name: string, color: string, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ name, color, roughness, metalness });
}

function physicalPaint(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    name: 'paint', color: '#435e69', roughness: .30, metalness: .18,
    clearcoat: .58, clearcoatRoughness: .32,
  });
}

function addMesh(
  parent: THREE.Object3D,
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: readonly [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  result.name = name;
  result.position.set(...position);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function panelGeometry(vertices: readonly number[], indices: readonly number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([...indices]);
  geometry.computeVertexNormals();
  return geometry;
}

function addTrimTube(parent: THREE.Object3D, points: readonly THREE.Vector3[], radius: number, material: THREE.Material, name: string): void {
  const curve = new THREE.CatmullRomCurve3([...points]);
  addMesh(parent, name, new THREE.TubeGeometry(curve, Math.max(8, points.length * 4), radius, 6, false), material);
}

/**
 * VELA-GT: original long-hood, fastback coupe. Its broad rear quarters, swept roof,
 * boomerang rear lamps and longer wheelbase distinguish the silhouette from ARC-S.
 */
export interface VelaGtBuildOptions { readonly lod?: 0 | 1; }

export function createVelaGt(options: VelaGtBuildOptions = {}): THREE.Group {
  const lowDetail = options.lod === 1;
  const root = new THREE.Group();
  root.name = 'VELA-GT';
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const paint = physicalPaint();
  const glass = standard('glass', '#243943', .16, .22);
  glass.transparent = true;
  glass.opacity = .82;
  glass.side = THREE.DoubleSide;
  const rubber = standard('rubber', '#171b1c', .88);
  const metal = standard('metal', '#a0a9a7', .27, .78);
  const trim = standard('trim', '#20292c', .45, .22);
  const lamp = standard('lamp', '#e5f0e9', .20, .08);
  lamp.emissive.set('#c5eaff');
  lamp.emissiveIntensity = .48;
  const red = standard('lamp-red', '#8b2524', .22, .08);
  red.emissive.set('#420b0a');
  red.emissiveIntensity = .24;
  const brake = standard('lamp-brake', '#ff382b', .19);
  brake.emissive.set('#ff1e10');
  brake.emissiveIntensity = .38;
  const reverse = standard('lamp-reverse', '#ecf5ea', .2);
  reverse.emissive.set('#e2f0ff');
  reverse.emissiveIntensity = .24;
  const interior = standard('interior', '#343a3b', .79);

  addMesh(body, 'vela-gt-profile-shell', closedShellGeometry(lowDetail), paint);
  // Solid painted crown section remains between the two independent glass panels.
  addMesh(body, 'vela-roof-panel', new THREE.BoxGeometry(1.38, .045, .77), paint, [0, .965, .145]);

  const windshield = panelGeometry([
    -.73, .63, -1.53, .73, .63, -1.53,
    -.69, .88, -.28, .69, .88, -.28,
  ], [0, 1, 2, 1, 3, 2]);
  const windshieldMesh = addMesh(body, 'windscreen-glazing', windshield, glass);
  windshieldMesh.castShadow = false;

  const rearGlass = panelGeometry([
    -.69, .88, .53, .69, .88, .53,
    -.77, .43, 1.5, .77, .43, 1.5,
  ], [0, 2, 1, 1, 2, 3]);
  const rearGlassMesh = addMesh(body, 'rear-fastback-glazing', rearGlass, glass);
  rearGlassMesh.castShadow = false;

  for (const side of [-1, 1] as const) {
    const sideFront = panelGeometry([
      side * .89, .27, -.72, side * .89, .34, -.04,
      side * .70, .84, -.04, side * .70, .85, -.72,
    ], [0, 1, 2, 1, 3, 2]);
    const frontMesh = addMesh(body, `side-front-glazing-${side}`, sideFront, glass);
    frontMesh.castShadow = false;
    const sideRear = panelGeometry([
      side * .89, .34, .08, side * .94, .31, .72,
      side * .77, .43, 1.20, side * .70, .86, .53,
    ], [0, 1, 2, 0, 2, 3]);
    const rearMesh = addMesh(body, `side-rear-glazing-${side}`, sideRear, glass);
    rearMesh.castShadow = false;

    addTrimTube(body, [
      new THREE.Vector3(side * .73, .63, -1.53), new THREE.Vector3(side * .70, .88, -.28),
      new THREE.Vector3(side * .70, .965, -.24),
    ], .036, trim, `vela-a-pillar-${side}`);
    addTrimTube(body, [
      new THREE.Vector3(side * .70, .965, -.24), new THREE.Vector3(side * .70, .965, .52),
    ], .04, trim, `vela-roof-rail-${side}`);
    addTrimTube(body, [
      new THREE.Vector3(side * .70, .965, .52), new THREE.Vector3(side * .77, .43, 1.20),
    ], .047, trim, `vela-c-pillar-${side}`);
    addTrimTube(body, [
      new THREE.Vector3(side * .89, .32, -.04), new THREE.Vector3(side * .72, .86, .015),
    ], .027, trim, `vela-b-pillar-${side}`);
  }

  // A narrow frame and defroster lines give the fastback glass readable scale.
  addTrimTube(body, [
    new THREE.Vector3(-.69, .88, .53), new THREE.Vector3(-.77, .43, 1.20),
    new THREE.Vector3(.77, .43, 1.20), new THREE.Vector3(.69, .88, .53),
  ], .012, trim, 'rear-glass-frame');
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const y = .88 - .45 * t;
    const z = .53 + .67 * t;
    const width = .69 + .08 * t;
    addTrimTube(body, [new THREE.Vector3(-width, y, z), new THREE.Vector3(width, y, z)], .0025, metal, `rear-defroster-${i}`);
  }

  // Defined cabin silhouette is visible through the glazing, without needing a cockpit view.
  addMesh(body, 'dashboard', new THREE.BoxGeometry(1.28, .16, .25), interior, [0, .27, -.55]);
  addMesh(body, 'rear-bench', new THREE.BoxGeometry(1.43, .20, .30), interior, [0, .08, .87]);
  for (const side of [-1, 1]) {
    addMesh(body, `front-seat-${side}`, new THREE.BoxGeometry(.42, .46, .47), interior, [side * .34, .12, -.02]);
  }

  // Long-hood GT face and broad rear-quarter signatures.
  addMesh(body, 'front-grille', new THREE.BoxGeometry(1.08, .18, .055), trim, [0, .005, -2.13]);
  addMesh(body, 'front-grille-blade', new THREE.BoxGeometry(.86, .035, .025), metal, [0, .01, -2.17]);
  addMesh(body, 'front-lower-intake', new THREE.BoxGeometry(1.30, .11, .09), trim, [0, -.17, -2.10]);
  addMesh(body, 'front-splitter', new THREE.BoxGeometry(1.48, .055, .16), trim, [0, -.25, -2.02]);
  addMesh(body, 'rear-diffuser', new THREE.BoxGeometry(1.42, .10, .08), trim, [0, -.22, 2.10]);
  addMesh(body, 'rear-registration-plate', new THREE.BoxGeometry(.34, .095, .02), metal, [0, .04, 2.174]);
  const frontLamps = new THREE.Group();
  frontLamps.name = 'lamp-front';
  body.add(frontLamps);
  const rearLamps = new THREE.Group();
  rearLamps.name = 'lamp-rear';
  body.add(rearLamps);
  for (const side of [-1, 1] as const) {
    addMesh(frontLamps, `vela-headlamp-${side}`, new THREE.BoxGeometry(.36, .09, .035), lamp,
      [side * .55, .20, -2.115]);
    // Two-piece swept outer lamp forms a broad, recognizable rear-quarter signature.
    addMesh(rearLamps, `vela-tail-lamp-quarter-${side}`, new THREE.BoxGeometry(.34, .12, .038), red,
      [side * .73, .20, 2.135]);
    addMesh(rearLamps, `vela-tail-lamp-wrap-${side}`, new THREE.BoxGeometry(.12, .23, .045), red,
      [side * .97, .285, 2.045]);
  }
  const brakeLights = new THREE.Group();
  brakeLights.name = 'brake-lights';
  body.add(brakeLights);
  addMesh(brakeLights, 'vela-brake-bar', new THREE.BoxGeometry(.74, .045, .03), brake, [0, .35, 2.13]);
  brakeLights.visible = false;
  const reverseLights = new THREE.Group();
  reverseLights.name = 'reverse-lights';
  body.add(reverseLights);
  addMesh(reverseLights, 'vela-reverse-left', new THREE.BoxGeometry(.12, .055, .035), reverse, [-.38, .08, 2.15]);
  addMesh(reverseLights, 'vela-reverse-right', new THREE.BoxGeometry(.12, .055, .035), reverse, [.38, .08, 2.15]);
  reverseLights.visible = false;

  const liveryPanels = new THREE.Group();
  liveryPanels.name = 'livery-panels';
  body.add(liveryPanels);
  const liveryMaterial = standard('livery', '#e2e0d6', .38, .12);
  const saltLine = new THREE.Group();
  saltLine.name = 'salt-line';
  liveryPanels.add(saltLine);
  for (const side of [-1, 1] as const) {
    addMesh(saltLine, `salt-line-quarter-${side}`, new THREE.BoxGeometry(.018, .018, .72), liveryMaterial,
      [side * 1.018, .36, .91]);
  }
  const copperRocker = new THREE.Group();
  copperRocker.name = 'copper-rocker';
  liveryPanels.add(copperRocker);
  const copperMaterial = standard('livery-copper', '#c27650', .40, .12);
  for (const side of [-1, 1] as const) {
    addMesh(copperRocker, `copper-rocker-${side}`, new THREE.BoxGeometry(.018, .075, 2.18), copperMaterial,
      [side * .95, -.045, .12]);
  }
  const harborWave = new THREE.Group();
  harborWave.name = 'harbor-wave';
  liveryPanels.add(harborWave);
  const waveMaterial = standard('livery-wave', '#65aaa9', .37, .1);
  for (const side of [-1, 1] as const) {
    const wave = panelGeometry([
      side * .92, -.03, -.68, side * .97, .02, .18,
      side * 1.025, .20, .91, side * .99, .13, .46,
    ], [0, 1, 2, 0, 2, 3]);
    addMesh(harborWave, `harbor-wave-panel-${side}`, wave, waveMaterial);
  }
  const doubleSlate = new THREE.Group();
  doubleSlate.name = 'double-slate';
  liveryPanels.add(doubleSlate);
  const slateMaterial = standard('livery-slate', '#283438', .34, .2);
  for (const x of [-.19, .19]) {
    addMesh(doubleSlate, `roof-slate-stripe-${x}`, new THREE.BoxGeometry(.065, .012, .61), slateMaterial,
      [x, .995, .145]);
  }
  for (const livery of liveryPanels.children) livery.visible = false;

  // Functional per-corner wheel groups are centered on physics WheelSnapshot centers.
  const tire = new THREE.CylinderGeometry(VELA_GT_PROFILE.wheelRadiusM, VELA_GT_PROFILE.wheelRadiusM, .245, lowDetail ? 16 : 28, 1);
  const forgedAlloy = standard('wheel-forged', '#a9b2af', .30, .8);
  const meshAlloy = standard('wheel-mesh', '#adb5b1', .27, .84);
  const steelAlloy = standard('wheel-steel', '#7b8380', .43, .68);
  const disc = standard('brake-disc', '#4d5657', .5, .68);
  const wheelStyles = [
    { id: 'forged', material: forgedAlloy, spokeCount: 5, spokeWidth: .046 },
    { id: 'mesh', material: meshAlloy, spokeCount: 12, spokeWidth: .018 },
    { id: 'steel', material: steelAlloy, spokeCount: 8, spokeWidth: .055 },
  ] as const;
  for (const anchor of VELA_GT_PROFILE.wheelCenters) {
    const wheel = new THREE.Group();
    wheel.name = anchor.id;
    wheel.position.set(anchor.x, anchor.y, anchor.z);
    root.add(wheel);
    addMesh(wheel, 'tire-sidewall', tire, rubber, [0, 0, 0]).rotation.z = Math.PI / 2;
    addMesh(wheel, 'vented-disc', new THREE.CylinderGeometry(.16, .16, .25, lowDetail ? 12 : 20), disc, [0, 0, 0]).rotation.z = Math.PI / 2;
    const outerFace = anchor.x < 0 ? -.129 : .129;
    for (const style of wheelStyles) {
      const styleRoot = new THREE.Group();
      styleRoot.name = `wheel-style-${style.id}`;
      styleRoot.visible = style.id === 'forged';
      wheel.add(styleRoot);
      const ring = new THREE.Mesh(new THREE.RingGeometry(.17, .245, lowDetail ? 16 : style.id === 'mesh' ? 32 : 24), style.material);
      ring.name = `${style.id}-wheel-annulus`;
      ring.position.x = outerFace;
      ring.rotation.y = anchor.x < 0 ? -Math.PI / 2 : Math.PI / 2;
      ring.castShadow = true;
      styleRoot.add(ring);
      const spokeCount = lowDetail ? Math.max(4, Math.round(style.spokeCount * .6)) : style.spokeCount;
      for (let spoke = 0; spoke < spokeCount; spoke++) {
        const angle = spoke * Math.PI * 2 / spokeCount;
        addMesh(styleRoot, `${style.id}-spoke-${spoke}`, new THREE.BoxGeometry(.03, .235, style.spokeWidth), style.material,
          [outerFace, Math.cos(angle) * .105, Math.sin(angle) * .105]).rotation.x = angle;
      }
      addMesh(styleRoot, `${style.id}-hub-cap`, new THREE.CylinderGeometry(.068, .068, .035, 16), trim,
        [outerFace, 0, 0]).rotation.z = Math.PI / 2;
    }
    addMesh(wheel, 'front-brake-caliper', new THREE.BoxGeometry(.06, .13, .19), standard('caliper','#bb7050',.48,.3),
      [anchor.x < 0 ? -.105 : .105, -.01, -.05]);
  }

  return root;
}

/** Releases shared resources once; useful when a source preview or future asset loader retires this model. */
export function disposeVelaGt(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

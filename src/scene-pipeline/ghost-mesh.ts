/**
 * Cheap ghost car geometry. The rival ghost used to be a full clone of the car (one draw call per mesh, every
 * triangle), which pushed Balanced past its budget in ghost races. This bakes a car part (body or one wheel) into ONE
 * position-only geometry in the part's local space and thins it by vertex clustering to a triangle target. With the
 * translucent additive ghost material the silhouette reads the same, at 5 draw calls (body + 4 wheels) in total.
 */
import * as THREE from 'three';

const relative = new THREE.Matrix4();
const inverseRoot = new THREE.Matrix4();
const v = new THREE.Vector3();

/** Triangle soup (x,y,z per corner) of every visible mesh under `root`, in root-local space without the root's own transform. */
export function collectTriangles(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true);
  inverseRoot.copy(root.matrixWorld).invert();
  const chunks: Float32Array[] = [];
  let total = 0;
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry?.attributes?.position) return;
    const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    if (count < 3) return;
    relative.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    const out = new Float32Array(Math.floor(count / 3) * 9);
    for (let i = 0; i < out.length / 3; i++) {
      const vertex = index ? index.getX(i) : i;
      v.fromBufferAttribute(position, vertex).applyMatrix4(relative);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    chunks.push(out); total += out.length;
  });
  const soup = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { soup.set(chunk, offset); offset += chunk.length; }
  return soup;
}

/** Vertex clustering on a grid of `cell` metres: indexed geometry without degenerate triangles. Numeric keys, no per-corner allocation. */
export function clusterTriangles(soup: Float32Array, cell: number): { positions: Float32Array; indices: Uint32Array } {
  const ids = new Map<number, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const corners = new Uint32Array(soup.length / 3);
  const B = 65536, H = 32768;
  for (let i = 0; i < corners.length; i++) {
    const x = soup[i * 3]!, y = soup[i * 3 + 1]!, z = soup[i * 3 + 2]!;
    // Cells within +-32768 per axis (cars are a few metres): a safe integer key.
    const key = ((Math.round(x / cell) + H) * B + (Math.round(y / cell) + H)) * B + (Math.round(z / cell) + H);
    let id = ids.get(key);
    if (id === undefined) { id = counts.length; ids.set(key, id); sums.push(0, 0, 0); counts.push(0); }
    sums[id * 3]! += x; sums[id * 3 + 1]! += y; sums[id * 3 + 2]! += z; counts[id]!++;
    corners[i] = id;
  }
  const kept = new Uint32Array(corners.length);
  let n = 0;
  for (let t = 0; t < corners.length; t += 3) {
    const a = corners[t]!, b = corners[t + 1]!, c = corners[t + 2]!;
    if (a === b || b === c || a === c) continue;
    kept[n++] = a; kept[n++] = b; kept[n++] = c;
  }
  const positions = new Float32Array(counts.length * 3);
  for (let i = 0; i < counts.length; i++) {
    positions[i * 3] = sums[i * 3]! / counts[i]!; positions[i * 3 + 1] = sums[i * 3 + 1]! / counts[i]!; positions[i * 3 + 2] = sums[i * 3 + 2]! / counts[i]!;
  }
  return { positions, indices: kept.slice(0, n) };
}

/** One ghost geometry for a car part, at most about `maxTriangles` triangles. */
export function buildGhostGeometry(root: THREE.Object3D, maxTriangles = 20_000): THREE.BufferGeometry {
  const soup = collectTriangles(root);
  let result: { positions: Float32Array; indices: Uint32Array } = { positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) };
  if (soup.length / 9 > maxTriangles) {
    for (let cell = 0.03; cell <= 0.5; cell *= 1.6) {
      result = clusterTriangles(soup, cell);
      if (result.indices.length / 3 <= maxTriangles) break;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The ghost of one car part: a single mesh carrying the part's own scale (position and rotation follow the snapshot). */
export function ghostPart(root: THREE.Object3D, material: THREE.Material, maxTriangles: number): THREE.Mesh {
  const mesh = new THREE.Mesh(buildGhostGeometry(root, maxTriangles), material);
  mesh.scale.copy(root.scale);
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.name = 'ghost-part';
  return mesh;
}

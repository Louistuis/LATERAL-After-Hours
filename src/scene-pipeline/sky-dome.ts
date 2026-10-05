import * as THREE from 'three';
import type { AtmosphereRecipe } from './atmosphere';

export interface SkyDome {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  setAtmosphere(recipe: AtmosphereRecipe): void;
  /** A small same-look sky sphere for the PMREM environment probe. The caller owns disposal. */
  createProbeMesh(radius: number): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  dispose(): void;
}

const SKY_VERTEX = /* glsl */`
  varying vec3 vSkyDir;
  void main() {
    vSkyDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Pin the dome to the far plane: it is drawn after the opaque world, so the depth test
    // rejects every pixel the world already covers instead of shading the sky full screen.
    gl_Position.z = gl_Position.w;
  }
`;

// One unlit draw: multi-stop gradient, sunset glow, low cloud deck lit from below,
// city glow on the horizon, stars and a moon. Colours are linear; tone mapping and
// output encoding match every lit surface so fog and sky meet without a seam.
const SKY_FRAGMENT = /* glsl */`
  uniform vec3 uZenith;
  uniform vec3 uUpper;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uFog;
  uniform vec3 uGlow;
  uniform vec3 uGlowDir;
  uniform float uGlowStrength;
  uniform float uSunDisc;
  uniform vec3 uCity;
  uniform float uCityStrength;
  uniform float uStars;
  uniform float uClouds;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudDark;
  uniform vec3 uMoonDir;
  uniform vec3 uMoonColor;
  uniform float uMoonSize;
  varying vec3 vSkyDir;

  float h11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float h31(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float a = .5, s = 0.;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= .5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vSkyDir);
    float e = d.y;
    float up = max(e, 0.);

    // Gradient: haze -> horizon -> mid -> upper -> zenith.
    vec3 col = mix(uFog, uHorizon, smoothstep(0., .05, e) * .85);
    col = mix(col, uMid, smoothstep(.03, .24, e));
    col = mix(col, uUpper, smoothstep(.2, .55, e));
    col = mix(col, uZenith, smoothstep(.5, 1., e));

    // Below the horizon settle into the fog colour (the ground hides it anyway).
    col = mix(col, uFog * .7, smoothstep(0., -.35, e));

    // Sunset / afterglow concentrated toward its azimuth and hugging the horizon.
    float sd = max(dot(d, normalize(uGlowDir)), 0.);
    float hugging = exp(-up * 7.0);
    float glow = (pow(sd, 6.) * .75 + pow(sd, 40.) * 1.1 + pow(sd, 400.) * 1.6) * hugging;
    col += uGlow * glow * uGlowStrength * smoothstep(-.12, .02, e);
    float disc = smoothstep(.99945, .99975, sd) * uSunDisc * smoothstep(-.01, .015, e);
    col += vec3(3.2, 1.9, .95) * disc;

    // Faint city / harbour lights haze all around the horizon.
    float az = atan(d.z, d.x);
    float patches = .55 + .75 * vnoise(vec2(az * 3.2, 4.1)) + .25 * vnoise(vec2(az * 11., 9.7));
    col += uCity * uCityStrength * patches * exp(-up * 13.) * smoothstep(-.1, .012, e);

    // Low cloud deck, lit from below by the afterglow and the city.
    if (uClouds > .001 && e > -.02) {
      vec2 cuv = d.xz / (up + .22) * 1.35;
      float n = fbm(cuv * .9 + vec2(3.7, 1.3));
      float bands = fbm(vec2(cuv.x * .35, cuv.y * 1.8) + 11.);
      float cover = smoothstep(.46 - uClouds * .14, .82, n * .75 + bands * .35);
      cover *= smoothstep(0., .13, e) * (1. - smoothstep(.45, .85, e));
      float lit = clamp(sd * 1.15 + (1. - up) * .22 + .35 * pow(1. - up, 3.) * uCityStrength, 0., 1.);
      vec3 cloud = mix(uCloudDark, uCloudLit, lit * lit);
      col = mix(col, cloud, clamp(cover * uClouds, 0., .92));
    }

    // Stars (hashed cells on the sphere) and a moon, hidden by haze and cloud.
    float clear = 1.;
    if (uStars > .001 && e > .02) {
      vec3 sp = d * 210.;
      vec3 ip = floor(sp);
      vec3 fp = fract(sp) - .5;
      float hs = h31(ip);
      vec3 off = vec3(h31(ip + 7.7), h31(ip + 3.1), h31(ip + 11.3)) - .5;
      float r = length(fp - off * .55);
      float star = smoothstep(.3, .0, r) * step(.972, hs);
      float bright = (hs - .972) / .028;
      vec3 tint = mix(vec3(.75, .85, 1.), vec3(1., .86, .7), h11(hs * 91.));
      col += tint * star * (.6 + 2.4 * bright) * uStars * smoothstep(.02, .3, e);
    }
    if (uMoonSize > .001) {
      float md = dot(d, normalize(uMoonDir));
      float moonDisc = smoothstep(.99935, .99965, md);
      float moonHalo = pow(max(md, 0.), 260.) * .55 + pow(max(md, 0.), 22.) * .09;
      col += uMoonColor * (moonDisc * 2.6 + moonHalo) * uMoonSize * smoothstep(-.02, .06, e);
    }

    gl_FragColor = vec4(max(col, vec3(0.)), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb += (h21(gl_FragCoord.xy) - .5) / 255.;
  }
`;

function makeUniforms(): Record<string, THREE.IUniform> {
  const c = () => ({ value: new THREE.Color() });
  const v = () => ({ value: new THREE.Vector3(0, 1, 0) });
  return {
    uZenith: c(), uUpper: c(), uMid: c(), uHorizon: c(), uFog: c(), uGlow: c(), uGlowDir: v(),
    uGlowStrength: { value: 1 }, uSunDisc: { value: 0 }, uCity: c(), uCityStrength: { value: 0 },
    uStars: { value: 0 }, uClouds: { value: 0 }, uCloudLit: c(), uCloudDark: c(),
    uMoonDir: v(), uMoonColor: c(), uMoonSize: { value: 0 },
  };
}

function writeAtmosphere(uniforms: Record<string, THREE.IUniform>, recipe: AtmosphereRecipe): void {
  const color = (name: string, hex: string) => (uniforms[name]!.value as THREE.Color).set(hex);
  color('uZenith', recipe.zenith); color('uUpper', recipe.upper); color('uMid', recipe.mid);
  color('uHorizon', recipe.horizon); color('uFog', recipe.fog); color('uGlow', recipe.glow);
  color('uCity', recipe.city); color('uCloudLit', recipe.cloudLit); color('uCloudDark', recipe.cloudDark);
  color('uMoonColor', recipe.moonColor);
  (uniforms.uGlowDir!.value as THREE.Vector3).set(...recipe.glowDirection).normalize();
  (uniforms.uMoonDir!.value as THREE.Vector3).set(...recipe.moonDirection).normalize();
  uniforms.uGlowStrength!.value = recipe.glowStrength;
  uniforms.uSunDisc!.value = recipe.sunDisc;
  uniforms.uCityStrength!.value = recipe.cityStrength;
  uniforms.uStars!.value = recipe.stars;
  uniforms.uClouds!.value = recipe.clouds;
  uniforms.uMoonSize!.value = recipe.moonSize;
}

/** One unlit backdrop draw: sunset gradient, cloud deck, city glow, stars and moon. */
export function createSkyDome(): SkyDome {
  const geometry = new THREE.SphereGeometry(1100, 48, 24);
  const material = new THREE.ShaderMaterial({
    name: 'after-hours-sky', uniforms: makeUniforms(), vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'coastal-sky-dome';
  mesh.userData.cameraCollision = false;
  // Last of the opaque pass, still before anything transparent blends over it.
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  const probes = new Set<THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>>();

  return {
    mesh,
    setAtmosphere(recipe): void { writeAtmosphere(material.uniforms, recipe); },
    createProbeMesh(radius): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
      const probe = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material.clone());
      probe.renderOrder = 1000;
      probe.frustumCulled = false;
      probes.add(probe);
      return probe;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      for (const probe of probes) { probe.geometry.dispose(); probe.material.dispose(); }
      probes.clear();
    },
  };
}

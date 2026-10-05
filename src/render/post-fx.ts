import * as THREE from 'three';
import type { QualityPreset } from '../../contracts/runtime-contracts';

/**
 * Cheap, quality-scaled HDR post chain for the night harbour.
 *
 *   scene (HalfFloat, MSAA) -> prefilter/downsample chain -> tent upsample -> composite
 *
 * The composite owns the ONLY tone-mapping and colour-space conversion of the frame: the scene pass
 * renders linear HDR into a render target (three skips tone mapping and sRGB encoding for targets),
 * so lamps, neon, tail lights and the sun disc can exceed 1.0 and bloom from real energy instead of
 * from sprite tricks. Bloom never runs on `low`; that tier keeps the grade and vignette in a single
 * full-screen composite and no blur chain.
 *
 * High and Ultra add a half-resolution "HQ" pass and a bilateral blur before the composite:
 *   - SSAO from the resolved depth texture (normals rebuilt from depth),
 *   - screen-space reflections on wet ground (the wet-surface hooks write a mirror mask into scene alpha),
 *   - analytic lamp in-scatter and ray-marched headlight cones (the "volumetric" light in the damp air),
 * and their composite adds lens dirt on the bloom. Ultra also gets camera motion blur from depth
 * reprojection, with the player car reprojected by its own motion so it stays sharp.
 * Low and Balanced keep their exact programs and pass count: none of this is allocated there.
 */

export interface PostGrade {
  /** Linear multiplier applied to the darks (teal push). sRGB hex. */
  readonly shadowTint: string;
  /** Linear multiplier applied to the highlights (warm push). sRGB hex. */
  readonly highlightTint: string;
  readonly saturation: number;
  readonly contrast: number;
  /** 0..1 corner darkening. */
  readonly vignette: number;
  readonly bloomStrength: number;
  /** Linear HDR luminance where bloom starts (after exposure). */
  readonly bloomThreshold: number;
}

export interface PostFxStats {
  readonly active: boolean;
  readonly bloom: boolean;
  readonly chromatic: boolean;
  readonly grain: boolean;
  readonly msaaSamples: number;
  readonly bloomLevels: number;
  /** Draw calls spent on post passes in the last frame (full-screen triangles). */
  readonly passes: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** High/Ultra half-resolution AO + reflections + in-scatter pass. */
  readonly hq?: boolean;
  readonly motionBlur?: boolean;
}

/** Light sources that scatter in the damp air (High/Ultra). World space; directions normalised. */
export interface PostScatterInput {
  readonly lamps: readonly THREE.Vector3[];
  /** Linear lamp colour times intensity. */
  readonly lampColor: THREE.Color;
  readonly headlights: readonly Readonly<{ position: THREE.Vector3; direction: THREE.Vector3 }>[];
  readonly headlightColor: THREE.Color;
  /** Cosine of the headlight cone half angle. */
  readonly headlightCos: number;
  /** Scattering coefficient of the air (per metre, times the isotropic phase). */
  readonly density: number;
}

export interface PostFx {
  readonly active: boolean;
  setQuality(quality: QualityPreset): void;
  setGrade(grade: PostGrade): void;
  setExposure(exposure: number): void;
  resize(): void;
  render(): void;
  /**
   * Links every scene and post program off the main thread (KHR_parallel_shader_compile) with the same
   * render-target state the real frame uses, so the first frame does not stall on synchronous shader links.
   */
  precompile(root?: THREE.Object3D): Promise<void>;
  stats(): PostFxStats;
  /** High/Ultra air in-scatter sources, refreshed every frame by the scene pipeline. */
  setScatter(input: PostScatterInput | null): void;
  /** Object kept sharp by Ultra motion blur (the player car): world centre and radius, or null. */
  setMotionFocus(center: THREE.Vector3 | null, radius?: number): void;
  /** Owner-review tuning hook; values persist until the next quality/grade change. */
  tune(values: Partial<Record<TuneKey, number>>): void;
  dispose(): void;
}

type TuneKey = 'bloomStrength' | 'bloomThreshold' | 'grain' | 'chromatic' | 'vignette' | 'bloomMix'
  | 'ao' | 'ssr' | 'scatter' | 'dirt' | 'motion';

interface QualityProfile {
  readonly bloom: boolean;
  readonly levels: number;
  readonly samples: number;
  readonly chromatic: number;
  readonly grain: number;
  /** Half-res AO + SSR + in-scatter pass (needs a depth texture). */
  readonly hq: boolean;
  readonly ssrSteps: number;
  readonly dirt: number;
  /** Shutter fraction for camera motion blur; 0 = off. */
  readonly motion: number;
}

const PROFILES: Readonly<Record<QualityPreset, QualityProfile>> = {
  low: { bloom: false, levels: 0, samples: 0, chromatic: 0, grain: 0, hq: false, ssrSteps: 0, dirt: 0, motion: 0 },
  balanced: { bloom: true, levels: 5, samples: 4, chromatic: 0, grain: 0.022, hq: false, ssrSteps: 0, dirt: 0, motion: 0 },
  high: { bloom: true, levels: 6, samples: 4, chromatic: 0.0011, grain: 0.03, hq: true, ssrSteps: 20, dirt: 0.8, motion: 0 },
  ultra: { bloom: true, levels: 6, samples: 4, chromatic: 0.0012, grain: 0.028, hq: true, ssrSteps: 32, dirt: 1, motion: 0.5 },
};
const MAX_SCATTER_LAMPS = 8;

const FULLSCREEN_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const PREFILTER_FRAGMENT = /* glsl */`
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  uniform float uThreshold;
  varying vec2 vUv;
  vec3 l3Bright(vec3 c) {
    if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
    c = clamp(c, vec3(0.0), vec3(24.0));
    float peak = max(c.r, max(c.g, c.b));
    float knee = uThreshold * 0.6 + 0.0001;
    float soft = clamp(peak - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 0.0001);
    float contribution = max(soft, peak - uThreshold) / max(peak, 0.0001);
    return c * contribution;
  }
  float l3Karis(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
  void main() {
    // 13 taps over a 4x4 footprint, grouped in five boxes, with Karis weighting so one
    // hot pixel cannot fizz as the camera moves.
    vec3 a = l3Bright(texture2D(tSource, vUv + uTexel * vec2(-2.0, -2.0)).rgb);
    vec3 b = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 0.0, -2.0)).rgb);
    vec3 c = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 2.0, -2.0)).rgb);
    vec3 d = l3Bright(texture2D(tSource, vUv + uTexel * vec2(-2.0,  0.0)).rgb);
    vec3 e = l3Bright(texture2D(tSource, vUv).rgb);
    vec3 f = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 2.0,  0.0)).rgb);
    vec3 g = l3Bright(texture2D(tSource, vUv + uTexel * vec2(-2.0,  2.0)).rgb);
    vec3 h = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 0.0,  2.0)).rgb);
    vec3 i = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 2.0,  2.0)).rgb);
    vec3 j = l3Bright(texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
    vec3 k = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 1.0, -1.0)).rgb);
    vec3 l = l3Bright(texture2D(tSource, vUv + uTexel * vec2(-1.0,  1.0)).rgb);
    vec3 m = l3Bright(texture2D(tSource, vUv + uTexel * vec2( 1.0,  1.0)).rgb);
    vec3 g0 = (a + b + d + e) * 0.25;
    vec3 g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25;
    vec3 g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    float w0 = l3Karis(g0) * 0.125, w1 = l3Karis(g1) * 0.125, w2 = l3Karis(g2) * 0.125;
    float w3 = l3Karis(g3) * 0.125, w4 = l3Karis(g4) * 0.5;
    vec3 sum = g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4;
    gl_FragColor = vec4(sum / (w0 + w1 + w2 + w3 + w4), 1.0);
  }
`;

const DOWNSAMPLE_FRAGMENT = /* glsl */`
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 a = texture2D(tSource, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
    vec3 b = texture2D(tSource, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
    vec3 c = texture2D(tSource, vUv + uTexel * vec2( 2.0, -2.0)).rgb;
    vec3 d = texture2D(tSource, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture2D(tSource, vUv).rgb;
    vec3 f = texture2D(tSource, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture2D(tSource, vUv + uTexel * vec2(-2.0,  2.0)).rgb;
    vec3 h = texture2D(tSource, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
    vec3 i = texture2D(tSource, vUv + uTexel * vec2( 2.0,  2.0)).rgb;
    vec3 j = texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    vec3 k = texture2D(tSource, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
    vec3 l = texture2D(tSource, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
    vec3 m = texture2D(tSource, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    vec3 sum = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

const UPSAMPLE_FRAGMENT = /* glsl */`
  uniform sampler2D tLow;   // upsampled result of the next smaller level
  uniform sampler2D tHigh;  // this level's own downsampled image
  uniform vec2 uTexel;      // texel of the low-res source
  uniform float uMix;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tLow, vUv + uTexel * vec2(-1.0, -1.0)).rgb
      + texture2D(tLow, vUv + uTexel * vec2( 0.0, -1.0)).rgb * 2.0
      + texture2D(tLow, vUv + uTexel * vec2( 1.0, -1.0)).rgb
      + texture2D(tLow, vUv + uTexel * vec2(-1.0,  0.0)).rgb * 2.0
      + texture2D(tLow, vUv).rgb * 4.0
      + texture2D(tLow, vUv + uTexel * vec2( 1.0,  0.0)).rgb * 2.0
      + texture2D(tLow, vUv + uTexel * vec2(-1.0,  1.0)).rgb
      + texture2D(tLow, vUv + uTexel * vec2( 0.0,  1.0)).rgb * 2.0
      + texture2D(tLow, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    gl_FragColor = vec4(texture2D(tHigh, vUv).rgb + s * (uMix / 16.0), 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloomOn;
  uniform float uBloomStrength;
  uniform float uExposure;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uVignette;
  uniform float uChromatic;
  uniform float uGrain;
  uniform float uTime;
  varying vec2 vUv;
#ifdef L3_HQ
  uniform sampler2D tHq;
  uniform sampler2D tDepth;
  uniform sampler2D tDirt;
  uniform float uDirt;
  uniform float uAoStrength;
  uniform float uMotion;
  uniform vec2 uResolution;
  uniform vec2 uProjZ;
  uniform mat4 uInvViewProj;
  uniform mat4 uPrevViewProj;
  uniform vec4 uFocus;
  uniform vec3 uFocusDelta;
  float l3ViewDepth(float d) { return uProjZ.y / (d * 2.0 - 1.0 + uProjZ.x); }
#endif

  vec3 l3Aces(vec3 color) {
    const mat3 inMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 outMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    color *= uExposure / 0.6;
    color = inMat * color;
    vec3 a = color * (color + 0.0245786) - 0.000090537;
    vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
    return clamp(outMat * (a / b), 0.0, 1.0);
  }
  float l3Hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  void main() {
    vec2 centered = vUv - 0.5;
    float r2 = dot(centered, centered);
    vec3 hdr;
    if (uChromatic > 0.0) {
      vec2 shift = centered * r2 * uChromatic * 2.0;
      hdr = vec3(texture2D(tScene, vUv + shift).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - shift).b);
    } else {
      hdr = texture2D(tScene, vUv).rgb;
    }
    if (any(isnan(hdr)) || any(isinf(hdr))) hdr = vec3(0.0);
#ifdef L3_HQ
    if (uMotion > 0.0) {
      // Camera motion blur: reproject this pixel's world position with last frame's view-projection. The
      // player car moved with the camera, so inside its sphere the car's own motion is undone first.
      float depth = texture2D(tDepth, vUv).r;
      vec4 world = uInvViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      world /= world.w;
      vec3 previousWorld = world.xyz;
      if (distance(world.xyz, uFocus.xyz) < uFocus.w) previousWorld -= uFocusDelta;
      vec4 previousClip = uPrevViewProj * vec4(previousWorld, 1.0);
      vec2 velocity = (vUv - (previousClip.xy / max(previousClip.w, 0.0001) * 0.5 + 0.5)) * uMotion;
      float speed = length(velocity);
      if (speed > 0.04) velocity *= 0.04 / speed;
      if (previousClip.w > 0.0 && length(velocity * uResolution) > 1.5) {
        float centerDepth = l3ViewDepth(depth);
        float jitter = l3Hash(gl_FragCoord.xy + fract(uTime * 5.3) * 37.0);
        vec3 sum = hdr;
        float weight = 1.0;
        for (int i = 0; i < 8; i++) {
          vec2 sampleUv = vUv + velocity * ((float(i) + jitter) / 8.0 - 0.5);
          // Foreground samples (the car over a moving background) must not smear onto the background.
          float sampleDepth = l3ViewDepth(texture2D(tDepth, sampleUv).r);
          float keep = step(centerDepth - 0.6, sampleDepth);
          vec3 s = texture2D(tScene, sampleUv).rgb;
          if (any(isnan(s)) || any(isinf(s))) keep = 0.0;
          sum += min(s, vec3(64.0)) * keep;
          weight += keep;
        }
        hdr = sum / weight;
      }
    }
    {
      // AO (alpha) darkens ambient-lit surfaces, not emitters; rgb carries wet reflections and air glow.
      vec4 hq = texture2D(tHq, vUv);
      float hdrLum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
      float ao = mix(1.0, hq.a, uAoStrength * (1.0 - smoothstep(1.2, 5.0, hdrLum)));
      hdr = hdr * ao + max(hq.rgb, vec3(0.0));
    }
    if (uBloomOn > 0.5) hdr += texture2D(tBloom, vUv).rgb * uBloomStrength * (1.0 + texture2D(tDirt, vUv).r * uDirt);
#else
    if (uBloomOn > 0.5) hdr += texture2D(tBloom, vUv).rgb * uBloomStrength;
#endif
    vec3 col = l3Aces(hdr);
    // Split-tone grade in display-linear: teal in the darks, warm in the lights, gentle S-curve.
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(uShadowTint, vec3(1.0), smoothstep(0.0, 0.42, lum));
    col = mix(col, col * uHighlightTint, smoothstep(0.38, 0.95, lum));
    col = mix(vec3(lum), col, uSaturation);
    col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
    float vig = smoothstep(0.92, 0.18, sqrt(r2) * 1.28);
    col *= mix(1.0 - uVignette, 1.0, vig);
    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    #include <colorspace_fragment>
    // Triangular dither removes 8-bit banding in the dusk sky; grain rides on it in the mid-tones.
    vec2 fc = gl_FragCoord.xy;
    float n = l3Hash(fc + fract(uTime * 7.13) * 91.7) + l3Hash(fc + 17.3 + fract(uTime * 3.77) * 53.1) - 1.0;
    float mid = 0.35 + 0.65 * (1.0 - abs(lum * 2.0 - 1.0));
    gl_FragColor.rgb += n * (1.0 / 255.0 + uGrain * mid);
  }
`;

const DEPTH_COMMON = /* glsl */`
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  vec3 l3ViewPos(vec2 uv, float d) {
    vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  float l3ViewZ(float d) { return -uProj[3][2] / (d * 2.0 - 1.0 + uProj[2][2]); }
  float l3Bayer4(vec2 fc) {
    ivec2 p = ivec2(mod(fc, 4.0));
    const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    return (m[p.x + p.y * 4] + 0.5) / 16.0;
  }
`;

/**
 * Half-resolution HQ pass. Output: rgb = wet-ground reflection + air in-scatter (added to HDR),
 * a = ambient occlusion. Every per-pixel loop is dithered with a 4x4 Bayer pattern that the following
 * 4x4 bilateral blur removes.
 */
const HQ_FRAGMENT = /* glsl */`
  ${DEPTH_COMMON}
  uniform sampler2D tScene;
  uniform vec2 uFullTexel;
  uniform vec3 uUpView;
  uniform float uSsrSteps;
  uniform float uSsrMax;
  uniform float uSsrStrength;
  uniform float uAoRadius;
  uniform float uAoIntensity;
  uniform float uProjScale;
  uniform vec4 uLamps[${MAX_SCATTER_LAMPS}];
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform vec4 uHeadPos[2];
  uniform vec3 uHeadDir[2];
  uniform vec3 uHeadColor;
  uniform float uHeadCos;
  uniform float uDensity;
  varying vec2 vUv;

  vec3 l3ProjectUv(vec3 q) {
    vec4 c = uProj * vec4(q, 1.0);
    return vec3(c.xy / c.w * 0.5 + 0.5, c.w);
  }

  void main() {
    float depth = texture2D(tDepth, vUv).r;
    bool sky = depth >= 0.99999;
    vec3 P = l3ViewPos(vUv, depth);
    vec3 dir = normalize(P);
    float rayLength = sky ? 160.0 : min(length(P), 160.0);
    float jitter = l3Bayer4(gl_FragCoord.xy);
    vec3 light = vec3(0.0);
    float ao = 1.0;

    // Lamp halos: closed-form in-scatter of an inverse-square point light along the view ray.
    if (uDensity > 0.0) {
      for (int i = 0; i < ${MAX_SCATTER_LAMPS}; i++) {
        if (i >= uLampCount) break;
        vec3 L = uLamps[i].xyz;
        float b = dot(L, dir);
        float h = sqrt(max(dot(L, L) - b * b, 0.09));
        float s = (atan((rayLength - b) / h) - atan(-b / h)) / h;
        light += uLampColor * (uLamps[i].w * s);
      }
      // Headlight cones: 12 dithered steps over the first 42 m of the ray.
      if (uHeadPos[0].w + uHeadPos[1].w > 0.0) {
        float reach = min(rayLength, 42.0);
        float stepLength = reach / 12.0;
        float cone = 0.0;
        for (int i = 0; i < 12; i++) {
          vec3 q = dir * ((float(i) + jitter) * stepLength);
          for (int k = 0; k < 2; k++) {
            vec3 v = q - uHeadPos[k].xyz;
            float d2 = dot(v, v);
            float c = dot(v, uHeadDir[k]) * inversesqrt(max(d2, 0.0001));
            cone += uHeadPos[k].w * smoothstep(uHeadCos, mix(uHeadCos, 1.0, 0.45), c) / (d2 + 1.5);
          }
        }
        light += uHeadColor * cone * stepLength;
      }
      light *= uDensity;
    }

    if (!sky) {
      // Ambient occlusion (Alchemy/SAO form) with normals rebuilt from the flatter neighbour pair.
      vec2 t = uFullTexel * 2.0;
      vec3 pr = l3ViewPos(vUv + vec2(t.x, 0.0), texture2D(tDepth, vUv + vec2(t.x, 0.0)).r);
      vec3 pl = l3ViewPos(vUv - vec2(t.x, 0.0), texture2D(tDepth, vUv - vec2(t.x, 0.0)).r);
      vec3 pu = l3ViewPos(vUv + vec2(0.0, t.y), texture2D(tDepth, vUv + vec2(0.0, t.y)).r);
      vec3 pd = l3ViewPos(vUv - vec2(0.0, t.y), texture2D(tDepth, vUv - vec2(0.0, t.y)).r);
      vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
      vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
      vec3 N = normalize(cross(dx, dy));
      float radiusPx = min(uAoRadius * uProjScale / max(-P.z, 0.1), 160.0);
      if (radiusPx > 3.0) {
        float r2 = uAoRadius * uAoRadius;
        float sum = 0.0;
        float spin = jitter * 6.2831853;
        for (int i = 0; i < 12; i++) {
          float a = (float(i) + 0.5) / 12.0;
          float angle = spin + a * 43.982297; // 7 turns
          vec2 offset = vec2(cos(angle), sin(angle)) * (a * radiusPx) * uFullTexel;
          vec2 sampleUv = vUv + offset;
          vec3 Q = l3ViewPos(sampleUv, texture2D(tDepth, sampleUv).r);
          vec3 v = Q - P;
          float vv = dot(v, v);
          float f = max(r2 - vv, 0.0);
          sum += f * f * f * max((dot(v, N) - 0.015 - 0.002 * -P.z) / (0.01 + vv), 0.0);
        }
        ao = clamp(1.0 - sum * uAoIntensity * 5.0 / (r2 * r2 * r2 * 12.0), 0.0, 1.0);
      }

      // Screen-space reflections on wet ground: the wet hooks wrote (1 - mirror) into scene alpha.
      float mirror = 1.0 - texture2D(tScene, vUv).a;
      if (uSsrSteps > 0.0 && mirror > 0.03) {
        vec3 Nw = normalize(uUpView);
        vec3 R = reflect(dir, Nw);
        float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-dir, Nw), 0.0), 5.0);
        float previousT = 0.0;
        float hitT = -1.0;
        vec2 hitUv = vec2(0.0);
        for (int i = 0; i < 40; i++) {
          if (float(i) >= uSsrSteps) break;
          float f = (float(i) + jitter) / uSsrSteps;
          float tStep = uSsrMax * f * f + 0.08;
          vec3 Q = P + R * tStep;
          if (Q.z > -0.1) break;
          vec3 s = l3ProjectUv(Q);
          if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) break;
          float gap = l3ViewZ(texture2D(tDepth, s.xy).r) - Q.z;
          if (gap > 0.0 && gap < 0.4 + tStep * 0.08) {
            float lo = previousT;
            float hi = tStep;
            hitUv = s.xy;
            for (int j = 0; j < 5; j++) {
              float mid = 0.5 * (lo + hi);
              vec3 M = P + R * mid;
              vec3 m = l3ProjectUv(M);
              if (l3ViewZ(texture2D(tDepth, m.xy).r) - M.z > 0.0) { hi = mid; hitUv = m.xy; } else { lo = mid; }
            }
            hitT = hi;
            break;
          }
          previousT = tStep;
        }
        if (hitT > 0.0 && texture2D(tDepth, hitUv).r < 0.99999) {
          vec2 edge = smoothstep(vec2(0.0), vec2(0.1), hitUv) * smoothstep(vec2(0.0), vec2(0.1), 1.0 - hitUv);
          float fade = edge.x * edge.y * (1.0 - smoothstep(0.55, 1.0, hitT / uSsrMax));
          vec3 c = texture2D(tScene, hitUv).rgb;
          if (!(any(isnan(c)) || any(isinf(c)))) light += min(c, vec3(20.0)) * (mirror * fresnel * fade * uSsrStrength);
        }
      }
    }
    gl_FragColor = vec4(light, ao);
  }
`;

const HQ_BLUR_FRAGMENT = /* glsl */`
  ${DEPTH_COMMON}
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float center = l3ViewZ(texture2D(tDepth, vUv).r);
    float tolerance = 0.04 * -center + 0.05;
    vec4 sum = vec4(0.0);
    float weight = 0.0;
    for (int y = -2; y < 2; y++) {
      for (int x = -2; x < 2; x++) {
        vec2 uv = vUv + (vec2(float(x), float(y)) + 0.5) * uTexel;
        float z = l3ViewZ(texture2D(tDepth, uv).r);
        float w = exp(-abs(z - center) / tolerance);
        sum += texture2D(tSource, uv) * w;
        weight += w;
      }
    }
    gl_FragColor = sum / max(weight, 0.0001);
  }
`;

/** Procedural lens dirt: soft smudges and a few streaks, lit only where bloom passes over them. */
function createDirtTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  let seed = 1337;
  const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const spots = Array.from({ length: 46 }, () => ({
    x: random(), y: random(), r: 0.02 + random() ** 2 * 0.14, a: 0.25 + random() * 0.75,
  }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let value = 0.08;
      for (const spot of spots) {
        const d = Math.hypot(u - spot.x, (v - spot.y) * 1.2) / spot.r;
        if (d < 1) value += spot.a * (1 - d * d) * (1 - d * d) * 0.6;
      }
      const ring = Math.hypot(u - 0.5, v - 0.5);
      value *= 0.55 + 0.9 * ring;
      const byte = Math.min(255, Math.round(value * 160));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = byte;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

type FullscreenMaterial = THREE.ShaderMaterial;

function makeMaterial(
  name: string, fragment: string, uniforms: Record<string, THREE.IUniform>, defines?: Record<string, string>,
): FullscreenMaterial {
  return new THREE.ShaderMaterial({
    name, uniforms, vertexShader: FULLSCREEN_VERTEX, fragmentShader: fragment,
    depthTest: false, depthWrite: false, toneMapped: false, fog: false, ...(defines ? { defines } : {}),
  });
}

function supportsHdrTargets(renderer: THREE.WebGLRenderer): boolean {
  return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

/** Returns an inactive pass-through when the GPU cannot render to half-float targets. */
export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  initialQuality: QualityPreset,
  baseRender: (scene: THREE.Scene, camera: THREE.Camera) => void,
): PostFx {
  const supported = supportsHdrTargets(renderer);
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  triangle.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(triangle);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    source: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() },
    threshold: { value: 1 }, low: { value: null as THREE.Texture | null }, high: { value: null as THREE.Texture | null },
    mix: { value: 0.7 },
  };
  const prefilter = makeMaterial('post-prefilter', PREFILTER_FRAGMENT, {
    tSource: uniforms.source, uTexel: uniforms.texel, uThreshold: uniforms.threshold,
  });
  const downsample = makeMaterial('post-downsample', DOWNSAMPLE_FRAGMENT, { tSource: uniforms.source, uTexel: uniforms.texel });
  const upsample = makeMaterial('post-upsample', UPSAMPLE_FRAGMENT, {
    tLow: uniforms.low, tHigh: uniforms.high, uTexel: uniforms.texel, uMix: uniforms.mix,
  });
  const compositeUniforms: Record<string, THREE.IUniform> = {
    tScene: { value: null }, tBloom: { value: null }, uBloomOn: { value: 0 }, uBloomStrength: { value: 0.3 },
    uExposure: { value: 1 }, uShadowTint: { value: new THREE.Color(1, 1, 1) }, uHighlightTint: { value: new THREE.Color(1, 1, 1) },
    uSaturation: { value: 1 }, uContrast: { value: 0 }, uVignette: { value: 0 },
    uChromatic: { value: 0 }, uGrain: { value: 0 }, uTime: { value: 0 },
  };
  const composite = makeMaterial('post-composite', COMPOSITE_FRAGMENT, compositeUniforms);
  // High/Ultra composite: the same uniforms objects (grade, exposure) plus the HQ inputs.
  const depthUniforms = {
    tDepth: { value: null as THREE.Texture | null }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
  };
  const hqTexture = { value: null as THREE.Texture | null };
  const compositeHq = makeMaterial('post-composite-hq', COMPOSITE_FRAGMENT, {
    ...compositeUniforms,
    tHq: hqTexture, tDepth: depthUniforms.tDepth, tDirt: { value: null }, uDirt: { value: 0 }, uAoStrength: { value: 0 }, // SSAO gated off: bands on grazing flat ground; owner tools can try tune({ ao })
    uMotion: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) }, uProjZ: { value: new THREE.Vector2() },
    uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
    uFocus: { value: new THREE.Vector4(0, -1e5, 0, 0) }, uFocusDelta: { value: new THREE.Vector3() },
  }, { L3_HQ: '' });
  const hq = makeMaterial('post-hq', HQ_FRAGMENT, {
    ...depthUniforms,
    tScene: { value: null }, uFullTexel: { value: new THREE.Vector2() }, uUpView: { value: new THREE.Vector3(0, 1, 0) },
    uSsrSteps: { value: 20 }, uSsrMax: { value: 48 }, uSsrStrength: { value: 0.9 },
    uAoRadius: { value: 0.9 }, uAoIntensity: { value: 1.1 }, uProjScale: { value: 500 },
    uLamps: { value: Array.from({ length: MAX_SCATTER_LAMPS }, () => new THREE.Vector4()) }, uLampCount: { value: 0 },
    uLampColor: { value: new THREE.Color() },
    uHeadPos: { value: [new THREE.Vector4(), new THREE.Vector4()] }, uHeadDir: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uHeadColor: { value: new THREE.Color() }, uHeadCos: { value: 0.9 }, uDensity: { value: 0 },
  });
  const hqBlur = makeMaterial('post-hq-blur', HQ_BLUR_FRAGMENT, {
    ...depthUniforms, tSource: { value: null }, uTexel: { value: new THREE.Vector2() },
  });
  let dirtTexture: THREE.DataTexture | null = null;
  let scatter: PostScatterInput | null = null;
  const focusCenter = new THREE.Vector3();
  const previousFocus = new THREE.Vector3();
  let focusRadius = 0;
  let focusValid = false;
  let previousFocusValid = false;
  const previousViewProjection = new THREE.Matrix4();
  let historyValid = false;
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scratchVector = new THREE.Vector3();
  const scratchMatrix = new THREE.Matrix4();

  let profile = PROFILES[initialQuality];
  let grade: PostGrade | null = null;
  let sceneTarget: THREE.WebGLRenderTarget | null = null;
  let hqTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  let downTargets: THREE.WebGLRenderTarget[] = [];
  let upTargets: THREE.WebGLRenderTarget[] = [];
  let passes = 0;
  let clock = 0;
  let disposed = false;
  let scatterScale = 1;
  let overrides: Partial<Record<'grain' | 'chromatic' | 'dirt' | 'motion', number>> = {};

  const newTarget = (width: number, height: number, samples: number, depth: boolean): THREE.WebGLRenderTarget => {
    const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false, samples,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
    return target;
  };
  const disposeBloom = (): void => {
    for (const target of [...downTargets, ...upTargets]) target.dispose();
    downTargets = []; upTargets = [];
  };
  const disposeHq = (): void => {
    for (const target of hqTargets ?? []) target.dispose();
    hqTargets = null;
  };
  const size = new THREE.Vector2();

  function allocate(): void {
    if (!supported || disposed) return;
    renderer.getDrawingBufferSize(size);
    const width = Math.max(2, size.x), height = Math.max(2, size.y);
    if (sceneTarget && sceneTarget.width === width && sceneTarget.height === height && sceneTarget.samples === profile.samples
      && (sceneTarget.depthTexture !== null) === profile.hq && downTargets.length === (profile.bloom ? profile.levels : 0)) return;
    sceneTarget?.depthTexture?.dispose();
    sceneTarget?.dispose();
    sceneTarget = newTarget(width, height, profile.samples, true);
    disposeHq();
    historyValid = false;
    if (profile.hq) {
      // The MSAA depth is resolved into this texture (three blits depth with the colour) for AO, SSR and blur.
      sceneTarget.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
      const halfWidth = Math.max(2, Math.floor(width / 2)), halfHeight = Math.max(2, Math.floor(height / 2));
      hqTargets = [newTarget(halfWidth, halfHeight, 0, false), newTarget(halfWidth, halfHeight, 0, false)];
      dirtTexture ??= createDirtTexture();
    }
    disposeBloom();
    if (!profile.bloom) return;
    for (let level = 0; level < profile.levels; level++) {
      const w = Math.max(2, Math.floor(width / 2 ** (level + 1))), h = Math.max(2, Math.floor(height / 2 ** (level + 1)));
      downTargets.push(newTarget(w, h, 0, false));
      if (level < profile.levels - 1) upTargets.push(newTarget(w, h, 0, false));
    }
  }

  function pass(material: FullscreenMaterial, target: THREE.WebGLRenderTarget | null): void {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
    passes++;
  }

  const viewProjection = new THREE.Matrix4();
  function renderHq(target: THREE.WebGLRenderTarget, [raw, blurred]: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]): void {
    const view = camera as THREE.PerspectiveCamera;
    depthUniforms.tDepth.value = target.depthTexture;
    depthUniforms.uProj.value.copy(view.projectionMatrix);
    depthUniforms.uInvProj.value.copy(view.projectionMatrixInverse);
    const u = hq.uniforms;
    u.tScene!.value = target.texture;
    (u.uFullTexel!.value as THREE.Vector2).set(1 / target.width, 1 / target.height);
    (u.uUpView!.value as THREE.Vector3).set(0, 1, 0).transformDirection(view.matrixWorldInverse);
    u.uProjScale!.value = view.projectionMatrix.elements[5]! * 0.5 * target.height;
    u.uSsrSteps!.value = profile.ssrSteps;
    const lamps = u.uLamps!.value as THREE.Vector4[];
    const heads = u.uHeadPos!.value as THREE.Vector4[];
    const headDirs = u.uHeadDir!.value as THREE.Vector3[];
    let lampCount = 0;
    if (scatter && scatter.density > 0) {
      for (const lamp of scatter.lamps) {
        if (lampCount >= MAX_SCATTER_LAMPS) break;
        scratchVector.copy(lamp).applyMatrix4(view.matrixWorldInverse);
        lamps[lampCount++]!.set(scratchVector.x, scratchVector.y, scratchVector.z, 1);
      }
      (u.uLampColor!.value as THREE.Color).copy(scatter.lampColor);
      for (let i = 0; i < 2; i++) {
        const head = scatter.headlights[i];
        if (!head) { heads[i]!.w = 0; continue; }
        scratchVector.copy(head.position).applyMatrix4(view.matrixWorldInverse);
        heads[i]!.set(scratchVector.x, scratchVector.y, scratchVector.z, 1);
        headDirs[i]!.copy(head.direction).transformDirection(view.matrixWorldInverse);
      }
      (u.uHeadColor!.value as THREE.Color).copy(scatter.headlightColor);
      u.uHeadCos!.value = scatter.headlightCos;
      u.uDensity!.value = scatter.density * scatterScale;
    } else {
      u.uDensity!.value = 0;
    }
    u.uLampCount!.value = lampCount;
    pass(hq, raw);
    hqBlur.uniforms.tSource!.value = raw.texture;
    (hqBlur.uniforms.uTexel!.value as THREE.Vector2).set(1 / raw.width, 1 / raw.height);
    pass(hqBlur, blurred);

    const c = compositeHq.uniforms;
    hqTexture.value = blurred.texture;
    c.tDirt!.value = dirtTexture;
    c.uDirt!.value = overrides.dirt ?? profile.dirt;
    (c.uResolution!.value as THREE.Vector2).set(target.width, target.height);
    (c.uProjZ!.value as THREE.Vector2).set(view.projectionMatrix.elements[10]!, -view.projectionMatrix.elements[14]!);
    viewProjection.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
    const motion = reducedMotion ? 0 : overrides.motion ?? profile.motion;
    c.uMotion!.value = historyValid ? motion : 0;
    (c.uInvViewProj!.value as THREE.Matrix4).copy(scratchMatrix.copy(viewProjection).invert());
    (c.uPrevViewProj!.value as THREE.Matrix4).copy(previousViewProjection);
    const focus = c.uFocus!.value as THREE.Vector4;
    const delta = c.uFocusDelta!.value as THREE.Vector3;
    if (focusValid) {
      focus.set(focusCenter.x, focusCenter.y, focusCenter.z, focusRadius);
      if (previousFocusValid) delta.subVectors(focusCenter, previousFocus); else delta.set(0, 0, 0);
    } else {
      focus.set(0, -1e5, 0, 0);
      delta.set(0, 0, 0);
    }
    previousFocus.copy(focusCenter);
    previousFocusValid = focusValid;
    previousViewProjection.copy(viewProjection);
    historyValid = true;
  }

  function applyGrade(): void {
    if (!grade) return;
    composite.uniforms.uShadowTint!.value.set(grade.shadowTint);
    composite.uniforms.uHighlightTint!.value.set(grade.highlightTint);
    composite.uniforms.uSaturation!.value = grade.saturation;
    composite.uniforms.uContrast!.value = grade.contrast;
    composite.uniforms.uVignette!.value = grade.vignette;
    composite.uniforms.uBloomStrength!.value = grade.bloomStrength;
    uniforms.threshold.value = grade.bloomThreshold;
  }

  return {
    get active(): boolean { return supported && !disposed && sceneTarget !== null; },
    setQuality(next): void {
      profile = PROFILES[next]; overrides = {};
      allocate();
    },
    setGrade(next): void { grade = next; applyGrade(); },
    setExposure(exposure): void { composite.uniforms.uExposure!.value = exposure; },
    resize(): void { allocate(); },
    setScatter(input): void { scatter = input; },
    setMotionFocus(center, radius = 3): void {
      focusValid = center !== null;
      if (center) focusCenter.copy(center);
      focusRadius = radius;
    },
    tune(values): void {
      if (values.bloomStrength !== undefined) composite.uniforms.uBloomStrength!.value = values.bloomStrength;
      if (values.bloomThreshold !== undefined) uniforms.threshold.value = values.bloomThreshold;
      if (values.vignette !== undefined) composite.uniforms.uVignette!.value = values.vignette;
      if (values.bloomMix !== undefined) uniforms.mix.value = values.bloomMix;
      if (values.grain !== undefined) overrides = { ...overrides, grain: values.grain };
      if (values.chromatic !== undefined) overrides = { ...overrides, chromatic: values.chromatic };
      if (values.dirt !== undefined) overrides = { ...overrides, dirt: values.dirt };
      if (values.motion !== undefined) overrides = { ...overrides, motion: values.motion };
      if (values.ao !== undefined) compositeHq.uniforms.uAoStrength!.value = values.ao;
      if (values.ssr !== undefined) hq.uniforms.uSsrStrength!.value = values.ssr;
      if (values.scatter !== undefined) scatterScale = values.scatter;
    },
    render(): void {
      if (!sceneTarget) { baseRender(scene, camera); return; }
      passes = 0;
      clock += 1 / 60;
      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      try {
        renderer.setRenderTarget(sceneTarget);
        baseRender(scene, camera);
        renderer.autoClear = true;
        let bloomTexture: THREE.Texture | null = null;
        if (profile.bloom && downTargets.length > 0) {
          uniforms.source.value = sceneTarget.texture;
          uniforms.texel.value.set(1 / sceneTarget.width, 1 / sceneTarget.height);
          pass(prefilter, downTargets[0]!);
          for (let level = 1; level < downTargets.length; level++) {
            const from = downTargets[level - 1]!;
            uniforms.source.value = from.texture;
            uniforms.texel.value.set(1 / from.width, 1 / from.height);
            pass(downsample, downTargets[level]!);
          }
          let carried: THREE.WebGLRenderTarget = downTargets[downTargets.length - 1]!;
          for (let level = downTargets.length - 2; level >= 0; level--) {
            uniforms.low.value = carried.texture;
            uniforms.high.value = downTargets[level]!.texture;
            uniforms.texel.value.set(1 / carried.width, 1 / carried.height);
            const out = upTargets[level]!;
            pass(upsample, out);
            carried = out;
          }
          bloomTexture = carried.texture;
        }
        compositeUniforms.tScene!.value = sceneTarget.texture;
        compositeUniforms.tBloom!.value = bloomTexture;
        compositeUniforms.uBloomOn!.value = bloomTexture ? 1 : 0;
        compositeUniforms.uChromatic!.value = overrides.chromatic ?? profile.chromatic;
        compositeUniforms.uGrain!.value = overrides.grain ?? profile.grain;
        compositeUniforms.uTime!.value = clock;
        if (hqTargets && sceneTarget.depthTexture) {
          renderHq(sceneTarget, hqTargets);
          pass(compositeHq, previousTarget);
        } else {
          pass(composite, previousTarget);
        }
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
      }
    },
    async precompile(root: THREE.Object3D = scene): Promise<void> {
      if (disposed) return;
      const previousTarget = renderer.getRenderTarget();
      const previousMaterial = quad.material;
      const pending: Promise<unknown>[] = [];
      try {
        // Program keys depend on whether a target is bound (tone mapping and output encoding happen in the composite).
        renderer.setRenderTarget(sceneTarget);
        pending.push(renderer.compileAsync(root, camera, scene));
        if (sceneTarget) {
          for (const material of [prefilter, downsample, upsample]) {
            quad.material = material;
            renderer.setRenderTarget(downTargets[0] ?? sceneTarget);
            pending.push(renderer.compileAsync(quad, quadCamera, quadScene));
          }
          if (hqTargets) {
            for (const material of [hq, hqBlur]) {
              quad.material = material;
              renderer.setRenderTarget(hqTargets[0]);
              pending.push(renderer.compileAsync(quad, quadCamera, quadScene));
            }
          }
          quad.material = hqTargets ? compositeHq : composite;
          renderer.setRenderTarget(previousTarget);
          pending.push(renderer.compileAsync(quad, quadCamera, quadScene));
        }
      } finally {
        quad.material = previousMaterial;
        renderer.setRenderTarget(previousTarget);
      }
      await Promise.all(pending);
    },
    stats(): PostFxStats {
      return {
        active: supported && !disposed && sceneTarget !== null, bloom: profile.bloom && downTargets.length > 0,
        chromatic: (overrides.chromatic ?? profile.chromatic) > 0, grain: (overrides.grain ?? profile.grain) > 0,
        msaaSamples: sceneTarget?.samples ?? 0, bloomLevels: downTargets.length, passes,
        renderWidth: sceneTarget?.width ?? 0, renderHeight: sceneTarget?.height ?? 0,
        hq: hqTargets !== null, motionBlur: hqTargets !== null && !reducedMotion && (overrides.motion ?? profile.motion) > 0,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sceneTarget?.depthTexture?.dispose();
      sceneTarget?.dispose(); sceneTarget = null;
      disposeBloom();
      disposeHq();
      dirtTexture?.dispose();
      triangle.dispose();
      for (const material of [prefilter, downsample, upsample, composite, compositeHq, hq, hqBlur]) material.dispose();
    },
  };
}

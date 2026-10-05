# 04 · Rendering and art direction

## The image we are aiming for

A car enters a broad harbor corner in warm low-angle light. Its paint carries a controlled sky reflection and a bright edge highlight without looking chrome-plated. Tire sidewalls remain rubber. A thin damp patch reflects the industrial skyline, while neighboring dry asphalt has diffuse texture and directional wear. Smoke blooms from the rear tires, drifts backward and leaves the exit visible. The road, guardrail and distant ridge retain scale and depth. The camera is clear enough to place the outside wheel near a clipping marker.

This brief asks for believable lighting and material relationships, not a checklist of expensive effects. A clean, consistent, richly authored frame beats maximum bloom, crushed shadows and a giant texture on poor geometry.

## Baseline renderer

Use Three.js WebGLRenderer with WebGL2 as the production path. Current Three.js documentation specifies WebGL2 and does not provide a WebGL1 fallback. Detect capability before allocating the full scene and present a helpful unsupported-device state rather than a black canvas. [S11]

Use a correctly managed linear lighting workflow with deliberate display output conversion. Validate albedo/emissive versus normal/roughness/metalness texture color-space treatment. Choose a single tone-mapping/exposure strategy and avoid double conversion or double tone mapping in post-processing. Record the implementation against the pinned engine version.

Use physically based standard materials for most scenery. Reserve the heavier physical car-paint/clearcoat model for the hero car and a small set of close-up assets. Three.js exposes clearcoat and other physical-material features, with greater per-pixel cost than simpler materials; every feature must earn its cost in capture comparisons. [S12]

## Materials

Cars need clearcoat over colored paint, separately treated glass, rubber, painted/plastic trim, headlights and metal wheel surfaces. Avoid overly smooth tires and identical roughness everywhere. Panel seams should read at gameplay distance without excessive dark outlines. Bodywork must not change apparent size between LODs.

Roads need macro variation plus restrained detail normals, believable lane markings, repair patches and local surface wear. Asphalt is not a perfect mirror. Damp regions are spatially authored roughness variation; any reflection technique must match those regions rather than turning the whole map into glass.

Scenery needs cohesive texel density, consistent light response and sensible silhouettes. Use geometry where it changes the skyline or close-up shape; use normal/detail textures where it does not. Bake static indirect lighting/ambient detail where helpful, keeping dynamic car lighting coherent with the same environment.

## Lighting, shadows and reflections

Ship two authored presentations: Golden Hour and Blue Hour. Each has its own sky/environment lighting and matching baked content where used. Switch between them in menus or before events, never by streaming an entire alternate map mid-drift. They share geometry and driving rules.

Prefer one main shadowed directional light, budgeted local lighting and baked contributions. Contact shadow treatment must ground the tires without visible hovering. Shadow transitions, bias and cascade bounds require real driving inspection. Do not shadow every decoration.

Use prefiltered environment probes as the baseline reflection solution. High settings may add a carefully bounded planar road reflection or another approved dynamic technique only if it clearly improves the actual driving view and stays within the frame budget. Never assume screen-space reflections, real-time GI or ray tracing are free. No mandatory ray tracing.

## Post-processing

Choose one effective anti-aliasing path per preset. Bloom is restrained and primarily attached to actual bright emitters. A subtle color grade may establish identity without hiding material errors. Motion blur is off by default or very light and must be independently disableable. Chromatic aberration and heavy film grain are not default decorations. Camera shake and speed effects have accessibility controls.

## VFX

Smoke intensity follows rear-wheel slip, load and speed; drifting on one contacting wheel must not emit four identical plumes. Use pooled particles, bounded lifetime, plausible drift direction, fading edges and tested transparency ordering. The player must still see the next corner. Skid marks follow the wheel contact path, use a bounded ring buffer and age out without unbounded memory. Brake lights, tiny contact sparks and road dust are contextual, not constant fireworks.

## Asset and draw strategy

Implement mesh LODs, frustum culling, chunk visibility, instancing for repeated props, shared materials and texture atlases where suitable. Load compressed GLB/geometry and KTX2 textures with locally bundled decoding/transcoding resources. KTX2Loader performs device-dependent transcoding; its support check and worker/transcoder setup must match the renderer and selected engine version. [S13]

Do not put transparent materials on entire opaque models. Do not allocate new textures, materials or particle objects every frame. Dispose of scene-owned GPU resources when unloading, with ownership rules that protect shared assets.

## Visual approval shots

Produce actual in-game captures for: sunny car three-quarter view; moving harbor drift; ridge hairpin; coastline wide shot; Blue Hour road/paint reflection; low-preset driving; touch HUD; garage; replay; and an edge case with maximum smoke. Each capture records commit, device, renderer, preset and resolution. At least one uninterrupted 60-second input-driven drive must accompany stills.

The art gate fails for placeholder cars, obvious texture seams, floating wheels, exposure pumping, unreadable smoke, harsh LOD popping, missing shadows or car/body collisions visibly disconnected from the road. Approval is based on the target gameplay camera, not solely on an offline render.

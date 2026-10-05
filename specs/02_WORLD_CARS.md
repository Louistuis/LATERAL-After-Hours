# 02 · World, routes and cars

## Region layout

Create one compact connected region, not three disconnected screenshots. Target 4–6 km of unique road centerline, excluding repeated laps and reverse variants. Use road curvature, sightlines, barriers and landmarks to make a small place feel authored. Streaming boundaries must follow bends, tunnels or grade changes without blocking active driving.

| District | Visual identity | Driving role | Required landmarks |
|---|---|---|---|
| Harbor Works | Weathered concrete, cargo structures, damp patches, warm industrial light | Wide learning turns, linked sweepers, a technical figure-eight | Crane silhouette, loading shed, water edge, service yard |
| Ridge Pass | Layered rock, pines, guardrails, open sky | Elevation, hairpins, weight transfer, longer transitions | Summit overlook, retaining wall, short tunnel, switchback vista |
| Coastline | Low modern buildings, coastal barriers, pale asphalt, sea reflections | Fast arcs, tight junction, rhythm and speed judgment | Sea wall, bridge, promenade corner, coastal service station |

The game takes place on a fictional closed-course playground. Use visual barriers and signage to explain boundaries. Water and inaccessible scenic areas need safe recovery, not invisible traps. There are no pedestrians to hit.

## Six physical routes

| Route ID | Route | District | Approximate length | Distinctive skill |
|---|---|---|---|---|
| HW-01 | Foundry Eight | Harbor | 0.7–0.9 km loop | Two linked arcs and a direction change |
| HW-02 | Quayside Run | Harbor | 0.9–1.2 km sprint | Long outside line into a tightening exit |
| RP-01 | Switchback Ascent | Ridge | 1.0–1.3 km sprint | Repeated hairpins and uphill throttle balance |
| RP-02 | Summit Circuit | Ridge | 0.8–1.1 km loop | Off-camber entry and a clean downhill exit |
| CL-01 | Promenade Loop | Coastline | 0.8–1.1 km loop | Sustained fast arc followed by a slow corner |
| CL-02 | Breakwater Sprint | Coastline | 1.0–1.4 km sprint | Bridge transition and a memorable final clipping point |

Lengths are design targets, not GIS measurements. Routes may share connecting road sections, but each must contain a distinct challenge sequence; merely reversing an existing path does not satisfy the six-route requirement. Every route needs checkpoints, respawn transforms, surface definitions, track-width bounds, camera obstruction metadata and performance capture positions.

## Road authoring contract

Store centerline/spline data in editable files with width, banking, elevation and segment IDs. Generate a visually smooth mesh and a separate simplified collision representation. Keep render detail out of collision geometry. Place curbs so the wheel contact model does not snag on seams. Export a route preview and drive the entire collision surface before decorating it.

Curvature progression must be intentional: obvious approach, readable apex, safe learning runoff and a comprehensible exit. Do not hide a required turn behind a decoration that looks drivable. Use sightline and track-width tests at the chase-camera height.

## Three fictional cars

| ID | Working name | Starting tune | Personality | Visible distinction |
|---|---|---|---|---|
| CAR-01 | ARC-S | 1,160 kg, 180 kW, RWD | Responsive, forgiving, lower inertia | Compact two-door liftback, short overhangs |
| CAR-02 | VELA-GT | 1,380 kg, 250 kW, RWD | Progressive power, balanced transitions | Longer coupe, broad rear quarter, distinctive lighting |
| CAR-03 | TORQ-R | 1,580 kg, 330 kW, RWD | High torque, heavier commitment | Wide-bodied grand tourer, long hood, muscular stance |

These are fictional starting design parameters, not claims about existing vehicles. Derive gear ratios, torque curves, axle loads and spring rates coherently. Validate the differences through handling telemetry and controlled tests, not by setting arbitrary top-speed labels.

Every car has actual wheel rotation and steering, plausible suspension travel, working brake/reverse lights, appropriate contact shadows, believable paint/glass/rubber separation and a modest interior silhouette visible through glass. Full modeled cockpit interaction is not required. Three repaints of one mesh do not count as three cars.

## Cosmetics and variants

Provide eight paint choices per car, three shared wheel designs and four authored liveries per car. Include clean stock appearances. Livery graphics must be original and unbranded. Each car has Grip, Balanced and Drift presets plus bounded steering response, differential behavior and brake-bias controls. Cosmetics do not require separate copies of entire geometry/texture packs.

## Acceptance assets

For every vehicle: editable source, runtime GLB, LOD variants, colliders, wheel/socket metadata, tune JSON, materials, audio mapping and license entry. For every route: authoring source, runtime scene data, collision build, checkpoint/respawn data, event variants and captured evidence. Deliver source assets without including font files in this handoff package.

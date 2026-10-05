# 10 · Assets, provenance and production rights

## Asset quality strategy

Treat original art as a real production workstream. Code-only geometry may support graybox milestones, but it must not remain the finished vehicle/roadscape merely because it is easy to generate. Use available DCC tools, commissioned/owner-provided sources or properly licensed source assets. Do not assume a paid asset budget or purchase anything without approval.

For every asset choose one of: original authored here; owner-provided with documented rights; or third-party with a verified license appropriate to the intended distribution. Record evidence at acquisition. An asset being free to download is not itself evidence of commercial redistribution rights.

## Provenance ledger

Use `templates/ASSET_LEDGER.csv` as the starting ledger. Required fields include asset ID, author/provider, source location, acquisition date, source hash, exact license/version, proof location, commercial-use review, embedded-game distribution review, attribution requirement/text, modifications, runtime paths, reviewer and status. `PENDING` assets cannot enter a release candidate.

Do not place borrowed screenshots, extracted game models, manufacturer logos, real advertising brands or unlicensed music in the shipped game. Do not imply affiliation with Forza, Microsoft, car manufacturers, Poki or CrazyGames beyond authorized platform integration. Working titles and fictional car names need review before public use. This is a production checklist, not a legal opinion.

## Editable source deliverables

Keep organized DCC/source files, material graphs, texture sources, road splines, tune files and audio project/source metadata. If a third-party license limits delivery of editable source files, record that restriction and choose a compliant replacement or obtain authorization; do not promise to redistribute what the license forbids.

Ship only the permitted optimized runtime outputs to portals. Keep receipts, licenses, source manifests and attribution text with the private production handover as appropriate. No font files are supplied by this documentation pack. During implementation, use system fonts or owner-supplied, appropriately licensed embedding assets; do not redistribute fonts merely because they exist on the build machine.

## Car pipeline

Model the three distinct silhouettes; validate scale, wheelbase, pivots, wheel radii and orientation against the physics contract. Create clean normals/UVs, restrained texture sets, material slots, suspension/wheel sockets and simple collision proxies. Produce LODs with preserved silhouette and stable contact placement. Export GLB, validate in the actual game renderer and inspect all three cars in both lighting presets.

## World pipeline

Keep track centerlines and road parameters editable. Bake/author terrain and scenery chunks with explicit bounds and dependencies. Use repeatable prop kits but vary grouping so the map does not look tiled. Collision geometry is separately simplified and driven end-to-end. Export lightmaps/probes with named preset ownership and test chunk boundaries.

## Texture and geometry processing

Use an automated pipeline for resizing, mipmaps, suitable geometry compression and KTX2 texture encoding. Bundle required runtime decoders/transcoders; verify their licenses and CSP behavior. Maintain content hashes so caches and save/ghost compatibility can be managed. Validate normal orientation, alpha mode, color spaces, texture channels, missing references and LOD bounds.

## Audio pipeline

Source or synthesize coherent engine layers, skid/impact sounds and music with documented rights. Keep a source attribution trail for each layer. Normalize loudness sensibly, trim unintended silence, remove audible seams and export tested browser formats with a fallback when needed. Test decode/load cost and avoid decompressing a long music library at boot.

## Acceptance

No missing files, unresolved provenance, forbidden marks, placeholder primary cars or undocumented source restrictions. Runtime asset manifests must match the delivered files by hash. The asset build must be reproducible from delivered permitted sources. Record external manual DCC steps honestly; do not call the pipeline fully automatic when it is not.

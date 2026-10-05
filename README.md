# LATERAL: After Hours

A browser drift and racing game set in a closed harbor district at night. Chain slides, bank your score, chase medals on three routes, and race other drivers online.

- **Cars:** five cars from a free starter muscle car up to a roughly 400 km/h hypercar, each with its own handling and its own engine sound.
- **Routes:** Foundry Eight (harbor), Seven Bends (ridge pass) and Neon Interchange (city), with time trial, drift attack and free drive modes.
- **Garage and shop:** paints, wheels, underglow, tyre smoke, plates and horns, bought with Marks earned from missions.
- **Online:** lobbies of up to eight drivers, leaderboards, daily challenge, ghost races, photo mode and replay.

Built with TypeScript, three.js and Rapier. The audio is generated in the browser, so there are no sound files.

## Run it

```bash
npm install
(cd server && npm install)   # the server's one dependency
npm run dev            # local dev server
npm run build:selfhost # build for your own server (dist/selfhost)
npm test               # unit tests
```

Other build targets: `build:standalone`, `build:owner-review`, `build:poki`, `build:crazygames-basic`, `build:crazygames-full`.

## Self-hosted server

`server/` is a small Node 24 server (one process, SQLite, one dependency: `ws`) that provides accounts, the Marks wallet, gifts, leaderboards and the multiplayer relay. The wallet is checked on the server, so purchases and earnings cannot be edited from the browser.

```bash
npm install
node server/build.mjs   # bundles dist/server.mjs
node server/dev.mjs     # local server with a temporary database
```

Configuration is by environment variables (see `server/config.ts`). Set `ADMIN_EMAILS`, `PROXY_KEY` and the proxy settings before exposing it. Nothing is purchasable with real money: Marks come from missions and gifts.

## Assets

The car models are not part of this repository. Place your own `challenger.glb`, `cybertruck.glb`, `mclaren-f1.glb`, `lancia-delta.glb` and `agera.glb` in `public/assets/cars/` (see `assets-source/ASSET_LEDGER.csv` for the asset list and rights status). Fonts are open source (SIL OFL 1.1), and the harbor world is generated from source in this repository.

## Security

See `SECURITY.md`.

## License

No license has been chosen yet, so all rights are reserved by default.

Made by Louis Nordbø.

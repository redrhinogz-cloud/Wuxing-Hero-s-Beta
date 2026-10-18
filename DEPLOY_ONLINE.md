# Deploying Wuxing Heroes Online v0.51

The server is a single Node.js process and requires Node 18+.

## Environment variables

- `PORT` — hosting platforms usually set this automatically. Defaults to `8080`.
- `HOST` — defaults to `0.0.0.0`.
- `WUXING_DATA_DIR` — directory used for persistent profile/match storage.

## Persistent storage

For cloud hosting, attach a persistent disk/volume and point `WUXING_DATA_DIR` at its mount path. Example:

```text
WUXING_DATA_DIR=/var/lib/wuxing
```

The server creates `wuxing-online-state.json` inside that directory.

Without persistent storage, same-browser unlocks still remain in browser localStorage, but server-side profiles, recovery and unfinished online matches can be lost when the host restarts or redeploys.

## Start command

```sh
node server.js
```

No npm packages beyond Node's built-in modules are required.

## Scaling

v0.51 is intentionally a single-server prototype. Use one application instance. A later production version should move profiles and match snapshots to a transactional database before horizontal scaling.

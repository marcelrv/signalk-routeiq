# Project Conventions for AI Agents

## Python (backend/)
- Always use `python3` (not `python`) when running scripts.
- Always use `pip3` (not `pip`) when installing packages.
- The backend has two scripts:
  - `enc_preprocessor.py` — accepts `--input` and `--output`
  - `nautical_routing_pipeline.py` — accepts `--input-dir` and `--output`
- Dependencies in `requirements.txt`. Install via `pip3 install --user --break-system-packages -r backend/requirements.txt`
- No system `sudo` available in dev environment; use `--user` + `--break-system-packages` for pip installs.

## Node.js / TypeScript (root, src/)
- **No local node/npm** — use Docker for all Node.js commands:
  ```
  docker run --rm -v "$(pwd):/work" -w /work node:22 <command>
  ```
- **Always pass `-u "$(id -u):$(id -g)"`** so build output is owned by your user, not root.
- **Always set `-e HOME=/tmp`** so npm cache (`/.npm`) doesn't cause EACCES (root-owned in node:22 image).
- Package manager: `npm` (not yarn, pnpm) — runs via Docker.
- Build: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run build`
- Dev: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run dev`
- Lint: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run lint`
- Format: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run format`
- Tests: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm test`
  (for now: `node --test --test-force-exit dist-test/routing.test.js`)
- Multi-step (build + test): `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 sh -c "npm run build && npm test"`
- All source in `src/`, compiled to `dist/`.
- ES modules (`"type": "module"` in package.json).

## Signal K Server Plugin Deployment
- Container name: `signalk-server` (runs `signalk/signalk-server:latest`)
- The dev directory is **bind-mounted** at `/home/node/.signalk/autoroute-dev` via `docker-compose.yml`.
  This path is OUTSIDE `node_modules/` so npm doesn't treat the bind-mount as a managed package.
- npm manages a `file:` symlink via `.signalk/package.json`:
  ```
  "signalk-autoroute": "file:autoroute-dev"
  ```
  which creates `node_modules/signalk-autoroute → ../autoroute-dev`.
- npm preserves `file:` symlinks during its install-tree operations for other packages.
- Build output in `dist/` is instantly visible to the SK server via the symlink.
- Plugin config stored at: `/home/node/.signalk/plugin-config-data/signalk-autoroute.json`
- Server data dir: `/home/node/.signalk/` (bind-mounted).
- Signal K server restarts via `docker restart signalk-server`.

### Deployment workflow (after code changes)
One command: `bash deploy.sh`
  — builds via Docker, then restarts the SK container.

The container must be running first. If it isn't:
```bash
docker compose -f /home/node/signalkdev/autoroute/docker-compose.yml up -d
```

### First-time setup (fresh container)
After `docker compose up -d`, run `npm install` once to create the `file:` symlink:
```bash
docker exec signalk-server sh -c "cd /home/node/.signalk && npm install"
```
Then `bash deploy.sh` to build and start using the plugin.

### If the container ever needs to be recreated
```bash
docker compose -f /home/node/signalkdev/autoroute/docker-compose.yml up -d
```
Then follow the first-time setup above.

### Required `package.json` settings
1. `"keywords": ["signalk-node-server-plugin"]` — **essential** for SK server to discover the plugin via `modulesWithKeyword()`.
2. `"signalK": { "pluginConstructor": "pluginConstructor", "name": "signalk-autoroute" }` — names the factory function.
3. `"type": "module"` + `"main": "dist/index.js"`.
4. Both **named** and **default** exports must point to `pluginConstructor` — SK's `importOrRequire()` returns `module.default` for ESM.

### Known issues
1. **`POST /router/push`** fails with *"PUT not supported for resources.routes.*"* — the SK server's delta PUT handler does not support writing to `resources.routes.*`. Use `putSelfPath(relPath, value, cb)` to attempt the write, but this currently returns 405.
2. **Vessel dimension subscriptions** must use `app.subscriptionmanager.subscribe(command, unsubscribeFns, errorCb, callback)` with `unsubscribeFns` as an array (not a function).
3. **`__dirname` is unavailable** in ES modules — use `new URL(import.meta.url).pathname` to derive paths at plugin-constructor scope.

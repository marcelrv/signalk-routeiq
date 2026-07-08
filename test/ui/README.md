# UI end-to-end tests (Playwright)

Validates the webapp against a **live SignalK server** with routing data loaded
(default `http://localhost:3000/signalk-autoroute/`, override with `BASE_URL`).

Covers: page load, settings Routing/View tabs + switch toggles, left-click
waypoint placement, click-on-route via insertion, undo/redo (buttons and
Ctrl+Z/Y), right-click context menu, manual draw mode (dashed-orange straight
legs), clear-route confirmation, and the mobile bottom-sheet/slide-over layout
with >=44 px tap targets. Screenshots land in `/shots`.

Run via Docker (no local node/browsers needed):

```bash
mkdir -p /tmp/ui-shots
docker run --rm --network host -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e HOME=/tmp \
  -v "$PWD/test/ui:/tests" -v /tmp/ui-shots:/shots -w /tests \
  mcr.microsoft.com/playwright:v1.54.0-noble \
  sh -c "npm init -y >/dev/null && npm i playwright@1.54.0 --no-audit --no-fund >/dev/null && node ui-e2e.mjs"
```

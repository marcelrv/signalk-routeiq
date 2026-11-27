import { readFileSync } from "node:fs";
import type { ProviderInfo } from "routeiq-core";

/** The plugin's own version, "" when its package.json cannot be read (the
 *  save then carries no version rather than failing). The file sits one level
 *  above both dist/ (bundle) and dist-tsc/ (type-checked build). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // unreadable package.json: report no version rather than fail the save
  }
  return "";
}

/** Passed to the passage profile builder and the GPX export, so every output
 *  names this plugin. */
export const PROVIDER: ProviderInfo = {
  name: "signalk-routeiq",
  version: packageVersion(),
  displayName: "SignalK RouteIQ Nautical Route Planner",
};

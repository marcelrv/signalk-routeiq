/**
 * routeiq-core: the routing engine, usable outside Signal K.
 *
 * Single public entry point. The version is a constant (checked against
 * package.json by test/version.test.ts) so the module never reads
 * package.json at runtime, which keeps it bundleable.
 */
export const CORE_VERSION: string = "0.0.0";

export * from "./types.js";
export * from "./navmesh.js";
export * from "./itinerary.js";
export * from "./route-description.js";
export * from "./passage-profile.js";
export * from "./gpx-export.js";
export * from "./tides.js";

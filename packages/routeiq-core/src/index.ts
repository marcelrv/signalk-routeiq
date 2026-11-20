/**
 * routeiq-core: the routing engine, usable outside Signal K.
 *
 * Empty for now; the engine moves here in later steps. The version is a
 * constant (checked against package.json by test/version.test.ts) so the
 * module never reads package.json at runtime, which keeps it bundleable.
 */
export const CORE_VERSION: string = "0.0.0";

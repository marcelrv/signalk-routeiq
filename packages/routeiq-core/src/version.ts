/**
 * The core's version. A constant (checked against package.json by
 * test/version.test.ts) so the module never reads package.json at runtime,
 * which keeps it bundleable. Lives in its own module so the engine can echo it
 * in every result without importing the package entry point.
 */
export const CORE_VERSION: string = "1.0.0";

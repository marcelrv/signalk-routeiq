/**
 * The logger the plugin hands to routeiq-core.
 *
 * It writes exactly what the engine's messages said before the core took an
 * injected logger: the message text is already complete (prefix included), and
 * only the level picks the console method. `debug` calls go to `console.log`
 * like the `info` ones, so the plugin's output is unchanged; the optional
 * `meta` is not printed.
 */

import type { Logger } from "routeiq-core";

export const pluginLogger: Logger = {
  debug: (message) => console.log(message),
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

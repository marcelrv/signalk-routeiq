/**
 * Test helpers for building a RoutingEngine from the plugin's config shape.
 *
 * The engine takes EngineOptions and keeps no vessel state. Most tests were
 * written against a PluginConfig plus a vessel set on the engine, so these map
 * the config onto options and put the vessel in `defaultVessel`, which is what
 * the engine uses for a request that carries no dimensions.
 */

import type { EngineOptions, RouteInputs, RoutingRequest } from 'routeiq-core';
import { resolveRouteInputs } from 'routeiq-core';
import { toEngineOptions } from '../dist-tsc/engine-options.js';
import type { PluginConfig, VesselDimensions } from '../dist-tsc/types.js';

export function testOptions(config: PluginConfig, dims?: VesselDimensions): EngineOptions {
  const options = toEngineOptions(config);
  if (dims) {
    options.defaultVessel = {
      draft: dims.draft ?? options.defaultVessel.draft,
      beam: dims.beam ?? options.defaultVessel.beam,
      airDraft: dims.airDraft ?? options.defaultVessel.airDraft,
    };
  }
  return options;
}

/** The effective inputs of a request on an engine with these options. */
export function inputsFor(options: EngineOptions, request: Partial<RoutingRequest> = {}): RouteInputs {
  return resolveRouteInputs(
    { start: { latitude: 0, longitude: 0 }, end: { latitude: 0, longitude: 0 }, ...request },
    options,
  );
}

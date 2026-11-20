/**
 * The plugin's vessel state and the filling of route requests.
 *
 * The routing engine keeps no vessel state: every request carries its own
 * draft, beam, air draft, speed and margins. The plugin is what knows the boat
 * (values read from the Signal K design.* paths, or set with PUT /vessel) and
 * the configured speed and margins, so it fills them into each request before
 * the engine sees it.
 */

import type {
  PluginConfig,
  RoutingRequest,
  VesselDimensions,
} from "./types.js";

/** Draft, beam and air draft the plugin currently plans with, metres. */
export type VesselValues = Required<VesselDimensions>;

/** What is used until Signal K (or an admin) provides the real values. */
export const INITIAL_VESSEL: VesselValues = {
  draft: 0, // unknown until Signal K provides it
  beam: 4, // reasonable default until Signal K provides it
  airDraft: 0,
};

/** Holder for the vessel dimensions: stream values and admin updates land
 *  here, requests read from here. Shared by the Signal K subscription code in
 *  index.ts and the API handler. */
export class VesselState {
  private values: VesselValues = { ...INITIAL_VESSEL };

  /** A copy of the current values. */
  get(): VesselValues {
    return { ...this.values };
  }

  /** Merge the given dimensions into the current ones. */
  update(dimensions: VesselDimensions): void {
    for (const key of ["draft", "beam", "airDraft"] as const) {
      const v = dimensions[key];
      if (v !== undefined) this.values[key] = v;
    }
  }
}

/**
 * A copy of `request` with every vessel, speed and margin field the request
 * left out filled in: the vessel dimensions from the plugin's vessel state,
 * speed and margins from the plugin configuration. Values the request carries
 * win. Called for every request that reaches the engine.
 */
export function fillRequest(
  request: RoutingRequest,
  vessel: VesselState,
  config: PluginConfig,
): RoutingRequest {
  const dims = vessel.get();
  return {
    ...request,
    draft: request.draft ?? dims.draft,
    beam: request.beam ?? dims.beam,
    airDraft: request.airDraft ?? dims.airDraft,
    speedKnots: request.speedKnots ?? config.averageSpeedKnots,
    safetyMarginDraft: request.safetyMarginDraft ?? config.safetyMarginDraft,
    safetyMarginBeam: request.safetyMarginBeam ?? config.safetyMarginBeam,
    safetyMarginAirDraft:
      request.safetyMarginAirDraft ?? config.safetyMarginAirDraft,
  };
}

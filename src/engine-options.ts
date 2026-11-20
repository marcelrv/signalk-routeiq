/**
 * Maps the plugin's saved configuration onto the routing engine's options.
 * The engine knows nothing of PluginConfig, the settings page or the retired
 * keys; this is the one place that translates.
 */

import type { EngineOptions } from "routeiq-core";
import type { PluginConfig } from "./types.js";
import { INITIAL_VESSEL } from "./vessel-state.js";

export function toEngineOptions(config: PluginConfig): EngineOptions {
  return {
    bboxMarginDeg: config.routingBBoxMargin,
    bboxMaxExtentDeg: config.routingBBoxMaxExtent,
    losSearchRadiusM: config.lineOfSightSearchRadius,
    waypointToleranceM: config.waypointTolerance,
    coverageGapM: config.coverageGapMeters,
    maxPenaltyDetourRatio: config.maxPenaltyDetourRatio,
    defaultSpeedKnots: config.averageSpeedKnots,
    defaultLockWaitMinutes: config.lockWaitMinutes,
    defaultBridgeWaitMinutes: config.bridgeWaitMinutes,
    defaultSafetyMarginDraftM: config.safetyMarginDraft,
    defaultSafetyMarginBeamM: config.safetyMarginBeam,
    defaultSafetyMarginAirDraftM: config.safetyMarginAirDraft,
    defaultUseTides: config.considerTides,
    defaultVessel: { ...INITIAL_VESSEL },
    // The plugin fills every request itself (see vessel-state.ts), so it runs
    // the engine non-strict.
    requireVesselInRequest: false,
  };
}

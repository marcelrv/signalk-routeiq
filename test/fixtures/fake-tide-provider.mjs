// A small tide-height provider module for tests of the worker host's
// `providers` option: three stations around the Zeelandbrug fixture, a pure
// sine tide (12.42 h, 1.2 m amplitude) fixed to `options.lowWaterMs`, so the
// host and an in-process engine see exactly the same heights.
const PERIOD_MS = 12.42 * 3_600_000;
const AMPLITUDE_M = 1.2;
const STEP_MS = 600_000;

const STATIONS = [
  { id: 'north', name: 'north', latitude: 51.69, longitude: 3.89 },
  { id: 'south', name: 'south', latitude: 51.53, longitude: 3.89 },
  { id: 'east', name: 'east', latitude: 51.61, longitude: 4.01 },
];

export default function createProvider(options = {}) {
  const lowWaterMs = options.lowWaterMs ?? Date.parse('2026-08-11T00:00:00Z');
  return {
    findStations: async () => STATIONS,
    fetchTimeline: async (_id, startMs, endMs) => {
      const timeline = [];
      for (let t = Math.floor(startMs / STEP_MS) * STEP_MS; t <= endMs + STEP_MS; t += STEP_MS) {
        const phase = ((t - lowWaterMs) / PERIOD_MS) * 2 * Math.PI;
        timeline.push({ time: new Date(t).toISOString(), level: AMPLITUDE_M * (1 - Math.cos(phase)) });
      }
      return { timeline };
    },
    probe: async () => ({ available: true, stations: STATIONS }),
  };
}

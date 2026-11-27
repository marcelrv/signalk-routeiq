import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  KNOTS_TO_MS,
  noCurrentField,
  prepareStationFlowField,
  prepareTideHeights,
  type CurrentProvider,
  type TideHeightProvider,
  type TideStationInfo,
} from '../dist/index.js';

// In-memory providers: the field math needs nothing from Signal K.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);

const heightStations: TideStationInfo[] = [
  { id: 'a', name: 'A', latitude: 52.0, longitude: 5.0 },
  { id: 'b', name: 'B', latitude: 52.1, longitude: 5.0 },
  { id: 'c', name: 'C', latitude: 52.0, longitude: 5.1 },
];

function heights(): TideHeightProvider {
  return {
    findStations: async () => heightStations,
    fetchTimeline: async (_id, startMs, endMs) => {
      const s = Math.floor(startMs / HOUR) * HOUR;
      const e = Math.ceil(endMs / HOUR) * HOUR;
      const timeline = [];
      for (let t = s; t <= e; t += 600_000) {
        // 0.5 m datum offset, 1 m amplitude, 12 h period
        const level = 0.5 + Math.sin((2 * Math.PI * (t - T0)) / (12 * HOUR));
        timeline.push({ time: new Date(t).toISOString(), level });
      }
      return { timeline };
    },
    probe: async () => ({ available: true, stations: heightStations }),
  };
}

function currents(): CurrentProvider {
  const st = { id: 'x', name: 'X', latitude: 52.0, longitude: 5.0, vectorCapable: true };
  return {
    findStations: async () => [st],
    fetchTimeline: async (_id, startMs, endMs) => {
      const timeline = [];
      for (let t = startMs; t <= endMs; t += 600_000) {
        timeline.push({ time: new Date(t).toISOString(), u: 1, v: 0 });
      }
      return { timeline };
    },
    probe: async () => true,
  };
}

describe('tide fields with in-memory providers', () => {
  const pts = [{ latitude: 52.02, longitude: 5.02 }];

  it('prepareTideHeights gives a rise above low water', async () => {
    const field = await prepareTideHeights(heights(), pts, T0, T0 + 10 * HOUR);
    assert.ok(field);
    assert.strictEqual(field.stations.length, 3);
    const high = field.riseAt(52.02, 5.02, T0 + 3 * HOUR);
    const low = field.riseAt(52.02, 5.02, T0 + 9 * HOUR);
    assert.ok(high !== null && high > 1.5);
    assert.ok(low !== null && low >= 0 && low < 0.5);
    assert.ok(field.maxRiseM <= 2.0 + 1e-9);
  });

  it('prepareTideHeights returns null with no stations or a failing provider', async () => {
    const none: TideHeightProvider = { ...heights(), findStations: async () => [] };
    assert.strictEqual(await prepareTideHeights(none, pts, T0, T0 + HOUR), null);
    const broken: TideHeightProvider = {
      ...heights(),
      findStations: async () => {
        throw new Error('down');
      },
    };
    assert.strictEqual(await prepareTideHeights(broken, pts, T0, T0 + HOUR), null);
  });

  it('a failing provider logs no error text above debug', async () => {
    const lines: Array<[string, string]> = [];
    const logger = {
      debug: (m: string) => lines.push(['debug', m]),
      info: (m: string) => lines.push(['info', m]),
      warn: (m: string) => lines.push(['warn', m]),
      error: (m: string) => lines.push(['error', m]),
    };
    const secret = 'at 52.123,5.456';
    const boom = async () => {
      throw new Error(secret);
    };
    await prepareTideHeights({ ...heights(), findStations: boom }, pts, T0, T0 + HOUR, logger);
    await prepareStationFlowField({ ...currents(), findStations: boom }, pts, T0, T0 + HOUR, logger);
    assert.ok(lines.some(([l]) => l === 'warn'));
    for (const [level, message] of lines) {
      if (level !== 'debug') assert.ok(!message.includes(secret), `${level}: ${message}`);
    }
    assert.ok(lines.some(([l, m]) => l === 'debug' && m.includes(secret)));
  });

  it('prepareStationFlowField samples station vectors, zero out of range', async () => {
    const field = await prepareStationFlowField(currents(), pts, T0, T0 + 2 * HOUR);
    assert.ok(field);
    assert.strictEqual(field.source, 'stations');
    const near = field.sample(52.0, 5.0, T0 + HOUR);
    assert.ok(Math.abs(near.u - 1) < 1e-9);
    assert.deepStrictEqual(field.sample(53.0, 6.0, T0 + HOUR), { u: 0, v: 0 });
    assert.ok(field.maxSpeedMs >= 1);
  });

  it('noCurrentField is zero everywhere', () => {
    const f = noCurrentField(heightStations);
    assert.strictEqual(f.source, 'heights');
    assert.deepStrictEqual(f.sample(52, 5, T0), { u: 0, v: 0 });
    assert.strictEqual(typeof KNOTS_TO_MS, 'number');
  });
});

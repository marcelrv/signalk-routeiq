# Passage profile (version 1)

When RouteIQ saves a calculated route to Signal K, it also stores the times it
calculated with the route. Other applications can then read the duration and
the waits back through the Resources API without routing again. This applies
to the webapp's **Save to Signal K** and to saves from the Freeboard-SK panel.
The webapp's **GPX export** carries the same numbers as RouteIQ GPX extensions
(see [In GPX](#in-gpx)).

The profile is stored in the route resource at
`feature.properties.passageProfile`:

```
GET /signalk/v2/api/resources/routes/<id>
→ { name, description, distance, feature: { geometry, properties: {
      coordinatesMeta, passageProfile } } }
```

All values use Signal K units: seconds, metres and m/s.

## Example

```json
{
  "version": 1,
  "provider": { "name": "signalk-routeiq", "version": "0.1.0-alpha.10" },
  "calculatedAt": "2026-11-15T10:00:00.000Z",
  "geometry": {
    "hash": "sha256:6f1c…",
    "method": "lonlat-e5",
    "pointCount": 14
  },
  "distance": 41114,
  "duration": {
    "total": 20520,
    "moving": 13320,
    "waiting": 7200,
    "waitingIncludedInTotal": true
  },
  "departure": null,
  "arrival": null,
  "assumptions": {
    "speedThroughWater": 3.087,
    "lockWait": 3600,
    "bridgeWait": 1800,
    "tide": { "enabled": false }
  },
  "waits": [
    { "type": "lock", "name": "Sluis A", "structure": "7", "distanceFromStart": 8123, "seconds": 3600,
      "position": { "latitude": 52.01, "longitude": 5.02 } },
    { "type": "bridge", "name": "Brug B", "structure": "9", "distanceFromStart": 9000, "seconds": 3600,
      "position": { "latitude": 52.012, "longitude": 5.027 } }
  ],
  "warnings": [
    { "type": "shallow", "level": "danger", "message": "…", "distanceFromStart": 500 }
  ]
}
```

## Fields

| Field | Meaning |
|---|---|
| `version` | Schema version. A change that would break a reader increments it. A reader should ignore a version it does not know. |
| `provider` | Who calculated the profile, and the plugin version. |
| `calculatedAt` | When the route was calculated (ISO 8601), or `null`. |
| `geometry` | Identifies the geometry the times belong to. See below. |
| `distance` | Length of the calculated route in metres. |
| `duration.total` | Expected passage time in seconds, from departure to arrival. It **includes** `waiting`. |
| `duration.moving` | `total − waiting`: time under way at the assumed speed, corrected for tide when tides were used. |
| `duration.waiting` | Seconds spent waiting at locks and opening bridges. |
| `departure`, `arrival` | ISO 8601 times when the plan is dated. Today a plan is dated only when tides were used. Both are `null` for an undated plan: an undated plan does not mean "leaving now". |
| `assumptions.speedThroughWater` | The constant speed through the water used for every leg (m/s). |
| `assumptions.lockWait`, `bridgeWait` | Default wait per lock and per opening span, in seconds. A structure can carry its own wait, so the per-structure `waits` can differ from these defaults. |
| `assumptions.tide` | `{enabled:false}`, or `{enabled:true, estimated, source}` when the times were corrected for tidal current. `estimated:true` means the tide comes from predictions or model data, not measurements. |
| `waits[]` | Each structure that added a wait, in route order. The `seconds` values add up to `duration.waiting`. `structure` is an opaque id for the physical structure, and `position` is where the structure is. A bridge that can be passed closed charges no wait and is not listed. |
| `warnings[]` | Every warning on the calculated route: route-level warnings (`type` and `message`), shallow or narrow legs, and notices from the charts (`type`, `level` = `danger`/`caution`/`info`, and where available `distanceFromStart`). |

### What the times are not

- **Not engine hours.** Moving time is how long the vessel is under way. During waits the engine may be running or stopped. Any fuel estimate needs a propulsion profile that RouteIQ does not have, and the profile contains no fuel figures.
- **Not clearance.** Having enough time, fuel or supplies for a passage says nothing about whether the vessel can navigate it. Check `warnings`.

## Geometry hash and stale profiles

Other applications, such as Freeboard-SK or another planner, can edit a route without RouteIQ knowing. The profile therefore records the geometry it was calculated for, and **a reader must check that hash before using the times**:

1. Take the resource's `feature.geometry.coordinates` (`[lon, lat, alt?]`).
2. For each position, compute `Math.round(lon * 100000)` and `Math.round(lat * 100000)`. Here `Math.round` means rounding half up, i.e. `floor(x + 0.5)`. Write `-0` as `0`. Drop any altitude.
3. Write each position as `lonInt,latInt` and join the positions with `;`.
4. Take the SHA-256 of that UTF-8 string and write it as `sha256:` followed by the lowercase hex digest.

For example, `[[5, 52], [-0.000001, 52.012346]]` becomes the string `500000,5200000;0,5201235`.

If the result differs from `geometry.hash`, or `pointCount` differs from the number of positions, the route has changed since it was calculated. Treat the profile as stale and do not use its times. A precision of 1e-5° (about 1 m) absorbs rounding from a round trip through a host, and any real edit still changes the hash.

RouteIQ never writes a profile for geometry that is not its own calculation:

- **Webapp**: `POST /signalk/v1/api/router/push` writes the route and its profile together, hashed over the coordinates it saves (the simplified waypoints).
- **Freeboard-SK panel**: the host saves the route. When the host reports `route.saved`, the panel sends the calculated result to `POST /signalk/v1/api/router/route/profile` with `{ href, route }`. The server reads the stored route and attaches the profile only if the stored geometry matches the calculated one. Otherwise it answers `409` and leaves the resource unchanged. If the route is saved again after an edit, the host either drops the profile or keeps one whose hash no longer matches. Either way, a reader can tell.

A route without calculated times, such as one from an older RouteIQ version, has no `passageProfile`.

## In GPX

`POST /signalk/v1/api/router/export/gpx` writes the same profile into the GPX
file's route, as extensions in the RouteIQ namespace
(`xmlns:ar="http://signalk.org/routeiq"`). They sit in `<rte><extensions>`,
after `<desc>` and before the first `<rtept>`, as GPX 1.1 requires:

```xml
<rte>
  <name>…</name>
  <desc>Route calculated by … - Distance: 41114m, Cost: 1.00, Duration: 5h42m (2h00m waiting)</desc>
  <extensions>
    <ar:passageProfile version="1" provider="signalk-routeiq" providerVersion="0.1.0-alpha.10" calculatedAt="2026-11-15T10:00:00.000Z">
      <ar:duration total="20520" moving="13320" waiting="7200" waitingIncludedInTotal="true"/>
      <ar:departure>2026-11-15T08:00:00.000Z</ar:departure>  <!-- dated plans only -->
      <ar:arrival>2026-11-15T13:42:00.000Z</ar:arrival>
      <ar:assumptions speedThroughWater="3.087" lockWait="3600" bridgeWait="1800" tide="false"/>
      <ar:wait type="lock" name="Sluis A" structure="7" distanceFromStart="8123" seconds="3600" lat="52.010000" lon="5.020000"/>
      <ar:warning type="shallow" level="danger" distanceFromStart="500">…</ar:warning>
    </ar:passageProfile>
  </extensions>
  <rtept …>
```

- The numbers and units are the same as in the Signal K profile.
- An undated plan has no `<ar:departure>` or `<ar:arrival>`.
- When tides were used, `<ar:assumptions>` also carries `tideEstimated` and `tideSource`.
- A route without calculated times gets no extensions and no duration in `<desc>`.
- Applications that do not know the namespace ignore the extensions. The duration in `<desc>` is there for them.
- GPX has no geometry hash. A GPX file is a copy, so there is no shared resource that someone could edit after the times were calculated.

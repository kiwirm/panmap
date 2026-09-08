# Georeferencing canonicalisation — plan

## Problem

The canonical `MapCrs` model (`src/map/model.ts`) already has every field:
`scale`, `auxiliaryScaleFactor`, `gridScaleFactor`, `declination`, `grivation`,
`refPoint`, `projected{…}`, `geographic{…}`. The OMap reader populates all of
them; the OCAD reader (`extractGeoreferencing`, `to-map.ts`) populates only a
subset from OCAD parameter-string 1039. So an OCD-sourced and an OMap-sourced
copy of the same map differ on the georeferencing block.

## What OCAD actually stores

Empirically (`via.ocd`, string 1039): `m`=scale, `i`=OCAD grid id (→ EPSG),
`x`/`y`=projected ref point, `a`=**grivation** (grid→magnetic), `g`/`d`=grid
spacing, `r`=real-coords flag. `b`/`c` are `0` (carry nothing). So OCAD stores
**grivation only** — NOT declination, NOT a geographic ref point, NOT a scale
factor.

After a round-trip, OCD-source is missing exactly three fields vs OMap:
`declination`, `geographic`, `auxiliaryScaleFactor`. Everything else (`scale`,
`grivation`, the entire `projected` block incl. `spec:"+init=epsg:2193"`) is
already identical.

## Derivable vs genuinely missing (numerically verified, EPSG:2193)

| Field | Recoverable? | How |
|---|---|---|
| `geographic.refPointDeg` | **Yes** | unproject `projected.refPoint` → lon/lat (exact to 8 dp) |
| `geographic.id`/`spec` | **Yes** | constants OOMapper always uses for WGS84 geographic |
| `declination` | **Yes** | `grivation + convergence`; convergence is a pure function of the projection at the ref point (`23.7 + 0.21 = 23.91`, exact). Grivation stays untouched, so coordinate transforms are unaffected. |
| `auxiliaryScaleFactor` | **No** | genuinely absent — reflects a user "ground-true scale" choice OCAD never records. Only reproducible by adopting an orienteering "ground-true" convention. |

**Insight:** OMap's `declination` is itself derived from grivation by OOMapper —
it's not extra survey data. Anything OOMapper computes, panmap can compute
identically, so the derived fields can be made byte-identical.

## Blocker

The reader runs offline, but `proj4` cannot resolve `+init=epsg:2193` without a
registered def. panmap currently only gets real proj strings by fetching
`epsg.io` over HTTPS in the CLI export path. So deriving `geographic`/
`declination` needs a **local** PROJ.4 def source.

## Recommendation

**A. Offline PROJ.4 defs.** Promote `proj4` to a direct dependency (already
transitive via `reproject`) and bundle a generated `epsg-proj4.json` (EPSG → proj
string) covering the `crs-grids` table (dominated by TM families — UTM/GK/NZTM/
national grids — so a curated set covers essentially all real files). Resolve
best-effort; **skip derivation when a def is unavailable — never fabricate.**

**B. Extend `extractGeoreferencing`** (`src/formats/ocad/to-map.ts`): after
building `projected`, when an EPSG def resolves and `refPoint`+`grivation` are
present, add a helper that computes lon/lat and numeric meridian convergence:

```ts
const [lon, lat] = proj4(def, WGS84, [x, y])
const p0 = proj4(WGS84, def, [lon, lat])
const pN = proj4(WGS84, def, [lon, lat + 1e-4])
const convergence = -Math.atan2(pN[0] - p0[0], pN[1] - p0[1]) * 180 / Math.PI
```

Then populate at OOMapper's serialisation precision (for byte-identity):
- `geographic = { id:'Geographic coordinates', spec:{language:'PROJ.4', value:'+proj=latlong +datum=WGS84'}, refPointDeg:{ lat:round(lat,8), lon:round(lon,8) } }`
- `declination = round(grivation + convergence, 2)`

**C. `auxiliaryScaleFactor` — policy, don't "read" it.**
- *Safe default:* leave unset for OCD sources (OCD and OMap then still differ by
  this one field, but nothing is fabricated). Optionally set `gridScaleFactor`
  (numerically derivable) so the difference is explicit.
- *Full-canonical option:* adopt a documented "orienteering maps are ground-true"
  convention and set `auxiliaryScaleFactor = round(1/gridScaleFactor, 6)`, behind
  an opt-in flag. This is the only field whose OCD↔OMap identity depends on an
  assumption.

**Net:** two of three missing fields are exactly derivable and should be added to
the OCAD reader; the third is genuinely absent and needs a convention. Only new
infra: offline PROJ.4 defs.

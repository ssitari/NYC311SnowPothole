# NYC 311 Snow & Pothole Complaint Rates

This map is to supplement the Data Club Intro to GIS workshop in Fall 2026.  This uses the data from the pothole complaint 
exercise and the snow complaint data as inspired by the equivalent workshop in Spring 2026.  There is a positive relationship between the complaint rates, but a weak one (r= 0.338 by my initial reckoning). Whether this relationship has more to do with the presence of complainers or the persistence of the snow is something we will talk about together.  At any rate, mostly an opportunity to show the interactive bivariate map template available at https://github.com/ssitari/ChoroplethEDABivariate

A bivariate choropleth of two NYC 311 complaint rates, linked to a scatterplot:
**winter 2025–26 snow complaints** on the X axis and **2026 pothole complaints**
on the Y, both per 1,000 residents, by 2020 Neighborhood Tabulation Area.

**[Open the map →](https://ssitari.github.io/NYC311SnowPothole/)**

Brush the map or the scatterplot to select neighborhoods; the other view
updates to match, and the stats panel compares the selection against the full
distribution. Selection works either way — lasso with Shift+drag, rectangle
with Shift+Alt+drag.

Across the 197 residential NTAs the two rates are positively but loosely
related: r = 0.34, slope 0.09 pothole complaints per additional snow complaint
per 1,000.

## Data

| Field | Meaning |
|---|---|
| `SnowRate` | Snow complaints per 1,000 residents, winter 2025–26 |
| `PotholeRate` | Pothole complaints per 1,000 residents, 2026 |
| `SnowPoints`, `PotholeComps` | Underlying complaint counts |
| `Population` | NTA population |
| `NTA2020`, `NTAName`, `BoroName`, `NTAType` | NYC DCP neighborhood identity |

Complaints come from NYC's
[311 Service Requests](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9),
aggregated to
[2020 NTAs](https://www.nyc.gov/content/planning/pages/resources/datasets/neighborhood-tabulation).

### Why 197 of 262 NTAs are mapped

65 NTAs are non-residential — parks, cemeteries, airports, rail yards. Their
populations run from 0 to a few hundred, which makes a per-capita rate
meaningless: Highland Park–Cypress Hills Cemeteries has 12 residents and would
plot at 2,250 pothole complaints per 1,000. Left in, a handful of these points
set the scale of the scatterplot and swallow the tertile class breaks.

So `SnowRate` and `PotholeRate` are null wherever `NTAType != '0'`. Those
polygons still draw, in grey, and keep their shape on the map; they are
excluded from the scatterplot, the class breaks and the statistics. The 197
that remain span 1.0–61.7 snow and 0.3–13.5 pothole complaints per 1,000.

### Regenerating the GeoJSON

`NTAs.gpkg` is the source, in EPSG:2263 (NY Long Island, ftUS). Reproject
first and simplify second — `ogr2ogr -simplify` reads its tolerance in source
units, and 0.0001 survey feet is no tolerance at all:

```bash
ogr2ogr -f GPKG -t_srs EPSG:4326 -nln nta nta4326.gpkg NTAs.gpkg
ogr2ogr -f GeoJSON -lco COORDINATE_PRECISION=5 -simplify 0.0001 simp.geojson nta4326.gpkg
```

That takes the file from 2.7 MB to 390 KB at roughly 11 m of tolerance. Then
null the rates for `NTAType != '0'`.

The raw 311 point layers behind the counts are gitignored — 65 MB that the
site does not need.

## Running it locally

The app loads ES modules over `fetch()`, so it needs a real HTTP server;
opening `index.html` as a `file://` URL will not work.

```bash
python3 -m http.server 8000   # or: npx serve .
```

Then open `http://localhost:8000`.

## Adapting it to other data

Built on [ChoroplethEDABivariate](https://github.com/ssitari/ChoroplethEDABivariate).
`app.js` is the engine and `config.js` is the only file you should need to
edit — it names the data file, the identity fields, and the variables.

This deployment differs from upstream in three small ways:

- The variable pairing is fixed, so the X/Y `<select>`s are gone from
  `index.html` and `VARIABLES` holds exactly two entries. `app.js` null-guards
  those lookups, so it still works with the pickers present.
- The legend is scaled 1.5× and sits at the top left of the map pane.
- `drawLegend()` caps the rotated Y label's height so a long variable name no
  longer stretches the legend panel past its grid.

Incoming GeoJSON must be WGS 84 (EPSG:4326), Polygon or MultiPolygon, with a
unique ID field and pre-computed numeric variables. `app.js` validates all of
that at load and reports problems on the page rather than in the console.

## License

MIT — see [LICENSE](LICENSE).

# Gaihozu Maps IIIF Builder

This project builds local IIIF Presentation 3 manifests from Stanford EarthWorks Gaihozu sheet-index records.

The friendly path is:

1. Use Stanford's public APIs and mirrors before touching live EarthWorks pages.
2. Discover index records from the public OpenGeoMetadata mirror instead of scraping EarthWorks search pages.
3. Fetch Stanford Stacks GeoJSON and PURL IIIF manifests one request at a time with a disk cache and a delay.

## Data Sources

- EarthWorks record JSON works for individual records, for example `https://earthworks.stanford.edu/catalog/stanford-ch237ht4777.json`.
- EarthWorks search endpoints can trigger an anti-bot challenge, so the builder does not crawl search results.
- OpenGeoMetadata mirrors EarthWorks metadata at `OpenGeoMetadata/edu.stanford.purl` under CC0.
- Stanford PURL serves public Cocina JSON as `https://purl.stanford.edu/{druid}.json`.
- Stanford IIIF Presentation v2 manifests are at `https://purl.stanford.edu/{druid}/iiif/manifest`.

## Install

```sh
pnpm install
```

## Build A Small Sample

```sh
pnpm run metadata:sync
pnpm run build:sample
pnpm run postprocess:data
pnpm run dev
```

The sample builds the `hx043dn1887` series and only the first 3 sheet manifests. Open the Vite URL and inspect:

- `/iiif/collection.json`
- `/iiif/series/hx043dn1887/manifest.json`
- `/geojson/hx043dn1887.geojson`

The Vite dev and preview servers send permissive CORS headers so local IIIF viewers can read the generated JSON and GeoJSON.

If Vite chooses a port other than 5173, regenerate the data with a matching base URL:

```sh
BASE_URL=http://127.0.0.1:5174 pnpm run build:sample
```

## Build Everything

```sh
REQUEST_DELAY_MS=750 pnpm run build:data
pnpm run postprocess:data
```

The full Gaihozu collection is large. At one Stanford request about every 0.75 seconds by default, fetching all sheet manifests can still take a while. Increase `REQUEST_DELAY_MS` if you want to be more conservative. The HTTP cache in `.cache/http` lets you stop and resume without re-fetching completed URLs. After the data build, `pnpm run postprocess:data` adds dissolved manifest-level `navPlace` geometry and rewrites the root collection with nested All Series, Broad Region, and Scale browse groupings.

Useful options:

```sh
node scripts/build-data.mjs --skip-manifests
node scripts/build-data.mjs --series-id hx043dn1887
node scripts/build-data.mjs --series-id hx043dn1887 --limit-sheets 10
node scripts/build-data.mjs --limit-series 5 --limit-sheets 2
node scripts/build-data.mjs --delay-ms 2500
node scripts/build-data.mjs --base-url http://localhost:5173
```

## Output

- `public/geojson/{series-druid}.geojson`: saved sheet-index GeoJSON.
- `public/iiif/series/{series-druid}/sheets.json`: extracted sheet manifest URLs.
- `public/iiif/series/{series-druid}/manifest.json`: combined IIIF manifest for one index series.
- `public/iiif/collection.json`: root collection with nested browse groupings.
- `public/iiif/collections/**/*.json`: standalone nested collections for all series, broad region, and scale.
- `data/index-records/{series-druid}.json`: local copy of the OpenGeoMetadata record.
- `data/build-report.json`: run summary and failed sheet manifest fetches.

## Notes

The combiner uses `@iiif/helpers/fetch`, which upgrades Stanford's Presentation 2 manifests into Presentation 3 resources before copying canvases into each combined series manifest. Canvas-level `navPlace` values are derived from the sheet-index GeoJSON geometry and include GeoJSON `bbox` extents.

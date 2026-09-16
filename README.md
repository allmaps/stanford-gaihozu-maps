# IIIF Gaihozu Maps Explorer

This project builds IIIF Presentation 3 manifests from Stanford EarthWorks Gaihozu sheet-index records and presents them in a reusable Svelte map atlas. The application reads its items, filters, dates, footprints, labels, and description from IIIF plus one small site configuration file.

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

## Configure the site

Edit `site.config.json` to reuse the interface with another collection. The important settings are:

- `collection`: the local or remote IIIF Presentation 3 root Collection.
- `canonicalDataBaseUrl`: the deployed base URL to rewrite to local paths during development.
- `title`, `description`, and `eyebrow`: optional interface copy. An empty title or description falls back to the root Collection.
- `repository`: the source-code link shown in the About dialog.
- `map`: initial view, light and dark MapLibre styles, containment margin, the zoom at which the point heat layer joins the polygon density view, and the sequential map palette. `containmentMargin` expands each viewport edge by a fraction of its width or height before excluding footprints that contain it. The default light style is OpenFreeMap Positron and the default palette is ColorBrewer BuGn.
- `labels`: collection-specific interface nouns and actions.

The application derives its filter groups from the Collection tree. Each direct child Collection of the root can contain nested option Collections. Manifest membership in those options becomes the available filter values. A branch such as `All Series` can link directly to manifests without becoming a filter.

Manifest `navDate` values drive the timeline. Manifest `navPlace` values drive footprints, viewport filtering, locator dots, and density. At broad zooms, translucent `navPlace` polygons accumulate to show overlapping coverage; at closer zooms, a centroid heat layer makes clusters easier to read. The interface does not depend on a separate GeoJSON index.

The interface uses Tailwind CSS utilities. Its light/dark preference is stored in the browser, and the map switches between the configured light and dark styles. MapLibre records zoom and center in the URL hash so a geographic view can be bookmarked or shared.

## Install and run

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

The full Gaihozu collection is large. At one Stanford request about every 0.75 seconds by default, fetching all sheet manifests can still take a while. Increase `REQUEST_DELAY_MS` if you want to be more conservative. The HTTP cache in `.cache/http` lets you stop and resume without re-fetching completed URLs.

After the build, `pnpm run postprocess:data` adds manifest-level `navPlace` geometry and prepares the IIIF graph for publication. Preparation keeps Collection children as links instead of embedding the complete hierarchy, removes generated `Date range` and `Index years` metadata, and sets each manifest thumbnail from the first painted image. Rich manifest discovery fields are published once in the graph; duplicate memberships remain lightweight references.

Run preparation directly after editing generated IIIF:

```sh
pnpm run prepare:data
```

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

- `static/geojson/{series-druid}.geojson`: saved sheet-index GeoJSON.
- `static/iiif/series/{series-druid}/sheets.json`: extracted sheet manifest URLs.
- `static/iiif/series/{series-druid}/manifest.json`: combined IIIF manifest for one index series.
- `static/iiif/collection.json`: compact root Collection containing links to browse groups.
- `static/iiif/collections/**/*.json`: standalone filter and membership Collections.
- `data/index-records/{series-druid}.json`: local copy of the OpenGeoMetadata record.
- `data/build-report.json`: run summary and failed sheet manifest fetches.

## Notes

The combiner uses `@iiif/helpers/fetch`, which upgrades Stanford's Presentation 2 manifests into Presentation 3 resources before copying canvases into each combined series manifest. Canvas-level `navPlace` values are derived from the sheet-index GeoJSON geometry and include GeoJSON `bbox` extents. Manifest-level `navPlace` contains dissolved series geometry for discovery on the atlas map.

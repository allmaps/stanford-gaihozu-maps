#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import clipping from "polygon-clipping";
import {
  assetLinksFromRecord,
  decadesFromRecord,
  metadataPairsFromRecord,
  navDateFromRecord,
  summaryTextFromRecord,
} from "./iiif-metadata.mjs";

const args = parseArgs(process.argv.slice(2));
const baseUrl = trimTrailingSlash(
  args["base-url"] || process.env.BASE_URL || "http://localhost:5173",
);
const collectionId = normalizeStanfordId(
  args["collection-id"] || process.env.COLLECTION_ID || "stanford-ch237ht4777",
);
const collectionDruid = collectionId.replace(/^stanford-/, "");
const metadataDir = path.resolve(
  args["metadata-dir"] ||
    process.env.OPEN_GEOMETADATA_DIR ||
    ".cache/opengeometadata/edu.stanford.purl",
);
const staticDir = path.resolve("static");
const dataDir = path.resolve("data");
const metadataRoot = path.join(metadataDir, "metadata-aardvark");
const basePath = new URL(baseUrl).pathname.replace(new RegExp("/$"), "");
const navPlaceContext = "http://iiif.io/api/extension/navplace/context.json";
const iiifPresentationContext = "http://iiif.io/api/presentation/3/context.json";
const { union: unionPolygons } = clipping;
const collectionLabels = new Map();

await main();

async function main() {
  assertMetadataSourcesAvailable();
  const seriesIds = await discoverSeriesIds();
  const collectionRecord = await readMetadataRecord(collectionDruid);
  addCollectionLabel(collectionRecord);
  const enrichedSeries = [];

  for (const [index, seriesDruid] of seriesIds.entries()) {
    const enriched = await enrichSeries(seriesDruid, index + 1, seriesIds.length);
    if (enriched) enrichedSeries.push(enriched);
  }

  const collection = buildRootCollection(enrichedSeries, collectionRecord);
  const seriesIndex = buildSeriesIndex(enrichedSeries);
  await writeCollectionTree(collection);
  await writeJson(path.join(staticDir, "iiif", "series-index.geojson"), seriesIndex);
  console.log(
    "Postprocessed " + enrichedSeries.length + " manifests and rewrote nested collection.",
  );
  console.log("Collection: " + baseUrl + "/iiif/collection.json");
  console.log("Series index: " + baseUrl + "/iiif/series-index.geojson");
}

function assertMetadataSourcesAvailable() {
  const indexRecordsDir = path.join(dataDir, "index-records");
  if (existsSync(metadataRoot) || existsSync(indexRecordsDir)) return;
  throw new Error(
    "No source metadata found. Run pnpm run metadata:sync or pnpm run build:data before postprocess:data.",
  );
}

async function readMetadataRecord(druid) {
  const file = metadataPathForDruid(druid);
  if (!existsSync(file)) return null;
  return readJson(file);
}

async function readRecord(recordPath, seriesDruid) {
  if (existsSync(recordPath)) return readJson(recordPath);
  const cached = await readMetadataRecord(seriesDruid);
  return cached || {};
}

async function addCollectionLabelsForRecord(record) {
  for (const id of array(record?.pcdm_memberOf_sm)) {
    const normalized = normalizeStanfordId(id);
    if (!normalized || collectionLabels.has(normalized)) continue;
    const collectionRecord = await readMetadataRecord(normalized);
    addCollectionLabel(collectionRecord || { id: normalized });
  }
}

function addCollectionLabel(record) {
  if (!record?.id) return;
  const normalized = normalizeStanfordId(record.id);
  const bare = normalizeBareDruid(normalized);
  const title = record.dct_title_s || normalized;
  collectionLabels.set(normalized, title);
  collectionLabels.set(bare, title);
}

function metadataPathForDruid(druid) {
  const bare = normalizeBareDruid(druid);
  return path.join(
    metadataRoot,
    bare.slice(0, 2),
    bare.slice(2, 5),
    bare.slice(5, 7),
    bare.slice(7),
    "geoblacklight.json",
  );
}

async function discoverSeriesIds() {
  const reportPath = path.join(dataDir, "build-report.json");
  if (existsSync(reportPath)) {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return array(report.series)
      .map((series) => normalizeBareDruid(series.id || ""))
      .filter(Boolean);
  }

  const seriesRoot = path.join(staticDir, "iiif", "series");
  const entries = await readdir(seriesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));
}

async function enrichSeries(seriesDruid, ordinal, total) {
  const manifestPath = path.join(staticDir, "iiif", "series", seriesDruid, "manifest.json");
  const geojsonPath = path.join(staticDir, "geojson", seriesDruid + ".geojson");
  const recordPath = path.join(dataDir, "index-records", seriesDruid + ".json");

  if (!existsSync(manifestPath) || !existsSync(geojsonPath)) return null;

  const [manifest, geojson, record] = await Promise.all([
    readJson(manifestPath),
    readJson(geojsonPath),
    readRecord(recordPath, seriesDruid),
  ]);
  await addCollectionLabelsForRecord(record);
  const title = record.dct_title_s || label(manifest.label) || seriesDruid;
  rewriteSeriesManifestUrls(manifest, seriesDruid);
  const sheets = extractSheets(geojson, seriesDruid);
  const sheetsByManifest = new Map(
    sheets.map((sheet) => [normalizeManifestUrl(sheet.manifestUrl), sheet]),
  );

  manifest["@context"] = mergeContexts(manifest["@context"], [
    navPlaceContext,
    iiifPresentationContext,
  ]);

  const manifestNavPlace = unionSheetsNavPlace(sheets, seriesDruid, title);
  if (manifestNavPlace) {
    manifest.navPlace = manifestNavPlace;
  }

  const navDate = navDateFromRecord(record);
  const canvasSeeAlso = canvasSeeAlsoResources(record, seriesDruid);
  manifest.seeAlso = dedupeResources([
    ...array(manifest.seeAlso),
    ...seriesSeeAlsoResources(seriesDruid),
    ...assetLinksFromRecord(record),
  ]);
  if (navDate) {
    manifest.navDate = navDate;
  } else {
    delete manifest.navDate;
  }

  for (const canvas of array(manifest.items)) {
    const sheet = sheetsByManifest.get(normalizeManifestUrl(sheetManifestUrlFromCanvas(canvas)));
    if (sheet?.navPlace) {
      canvas.navPlace = structuredClone(sheet.navPlace);
    }
    if (navDate) {
      canvas.navDate = navDate;
    } else {
      delete canvas.navDate;
    }
    canvas.seeAlso = dedupeResources([...array(canvas.seeAlso), ...canvasSeeAlso]);
  }

  const regions = regionsForRecord(record, manifest, title);
  const scales = scalesForRecord(record, manifest, title);
  const themes = themesForRecord(record);
  const subjects = subjectsForRecord(record);
  const decades = decadesFromRecord(record);
  manifest.metadata = buildSeriesMetadata(record, seriesDruid, sheets, manifest, { regions, scales });

  await writeJson(manifestPath, manifest);
  await rewriteSheetsJson(seriesDruid);

  const ref = manifestReference(manifest, record, sheets, { regions, scales });

  if (ordinal === 1 || ordinal % 25 === 0 || ordinal === total) {
    console.log("[postprocess " + ordinal + "/" + total + "] " + seriesDruid);
  }

  return {
    seriesDruid,
    title,
    manifest,
    record,
    ref,
    regions,
    scales,
    themes,
    subjects,
    decades,
    sheets,
  };
}

async function rewriteSheetsJson(seriesDruid) {
  const sheetsPath = path.join(staticDir, "iiif", "series", seriesDruid, "sheets.json");
  if (!existsSync(sheetsPath)) return;
  const text = await readFile(sheetsPath, "utf8");
  const rewritten = text.replace(
    new RegExp("https?://(?:localhost|127\\.0\\.0\\.1):[0-9]+(?=/(?:iiif|geojson)/)", "g"),
    baseUrl,
  );
  if (rewritten !== text) await writeFile(sheetsPath, rewritten);
}

function rewriteSeriesManifestUrls(manifest, seriesDruid) {
  manifest.id = baseUrl + "/iiif/series/" + seriesDruid + "/manifest.json";
  manifest.partOf = [
    {
      id: baseUrl + "/iiif/collection.json",
      type: "Collection",
      label: languageMap("Gaihozu Index Maps"),
    },
  ];
  manifest.seeAlso = array(manifest.seeAlso).map((item) => ({
    ...item,
    id: rewriteStaticDataUrl(item.id),
  }));
}

function rewriteStaticDataUrl(id) {
  if (!id) return id;
  try {
    const pathname = new URL(id).pathname;
    const match = pathname.match(new RegExp("/(?:iiif|geojson)/"));
    return match?.index === undefined ? id : baseUrl + pathname.slice(match.index);
  } catch {
    const match = String(id).match(new RegExp("/(?:iiif|geojson)/"));
    return match?.index === undefined ? id : baseUrl + String(id).slice(match.index);
  }
}

function buildSeriesIndex(series) {
  const features = series.flatMap((item) => {
    const navFeature = item.manifest?.navPlace?.features?.[0];
    if (!navFeature?.geometry) return [];
    const geometry = structuredClone(navFeature.geometry);
    const bbox = geometryBbox(geometry);
    return [
      compactObject({
        id: item.seriesDruid,
        type: "Feature",
        properties: compactObject({
          id: item.seriesDruid,
          seriesDruid: item.seriesDruid,
          manifestId: item.manifest.id,
          label: item.title,
          regions: item.regions,
          scales: item.scales,
          themes: item.themes,
          decades: item.decades,
          navDate: item.manifest.navDate,
          sheetCount: item.sheets.length,
          sourceFeatureCount: navFeature.properties?.sourceFeatureCount,
          thumbnailId: item.manifest.thumbnail?.[0]?.id,
        }),
        geometry,
        bbox,
      }),
    ];
  });

  return compactObject({
    type: "FeatureCollection",
    name: "Gaihozu unionized sheet indices",
    features,
    bbox: combineFeatureBboxes(features),
  });
}

function combineFeatureBboxes(features) {
  const bbox = emptyBbox();
  for (const feature of features) extendBbox(bbox, feature.bbox);
  return bbox.valid ? [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] : undefined;
}

function buildRootCollection(series, collectionRecord) {
  const sortedSeries = [...series].sort((left, right) =>
    label(left.ref.label).localeCompare(label(right.ref.label), "en", { numeric: true }),
  );
  const collectionMetadata = collectionViewMetadata(collectionRecord);
  const allSeries = buildCollection({
    id: baseUrl + "/iiif/collections/all-series.json",
    label: "All Series",
    summary: sortedSeries.length + " Gaihozu index-map series.",
    metadata: collectionViewMetadata(collectionRecord, [
      metadataPair("Collection view", "All Series"),
      metadataPair("Series in view", String(sortedSeries.length)),
    ]),
    items: sortedSeries.map((item) => item.ref),
  });
  const byRegion = buildGroupingCollection({
    id: baseUrl + "/iiif/collections/by-region.json",
    label: "By Broad Region",
    summary: "Series grouped from OpenGeoMetadata place headings. A series can appear in more than one region.",
    basePath: "by-region",
    series: sortedSeries,
    groupsForSeries: (item) => item.regions,
    collectionRecord,
  });
  const byScale = buildGroupingCollection({
    id: baseUrl + "/iiif/collections/by-scale.json",
    label: "By Scale",
    summary: "Series grouped by map scale parsed from the record title. A multi-scale title can appear in more than one group.",
    basePath: "by-scale",
    series: sortedSeries,
    groupsForSeries: (item) => item.scales,
    compareGroups: compareScaleLabels,
    collectionRecord,
  });
  const byTheme = buildGroupingCollection({
    id: baseUrl + "/iiif/collections/by-theme.json",
    label: "By Theme",
    summary: "Series grouped by OpenGeoMetadata theme headings. A series can appear in more than one theme.",
    basePath: "by-theme",
    series: sortedSeries,
    groupsForSeries: (item) => item.themes,
    collectionRecord,
  });
  const bySubject = buildGroupingCollection({
    id: baseUrl + "/iiif/collections/by-subject.json",
    label: "By Subject",
    summary: "Series grouped by OpenGeoMetadata subject headings. A series can appear in more than one subject.",
    basePath: "by-subject",
    series: sortedSeries,
    groupsForSeries: (item) => item.subjects,
    collectionRecord,
  });
  const byDecade = buildGroupingCollection({
    id: baseUrl + "/iiif/collections/by-decade.json",
    label: "By Decade",
    summary: "Series grouped by decades covered in OpenGeoMetadata temporal coverage. A series can appear in more than one decade.",
    basePath: "by-decade",
    series: sortedSeries,
    groupsForSeries: (item) => item.decades,
    compareGroups: compareDecadeLabels,
    collectionRecord,
  });

  return buildCollection({
    id: baseUrl + "/iiif/collection.json",
    label: collectionRecord?.dct_title_s || "Gaihozu Index Maps",
    summary:
      summaryTextFromRecord(collectionRecord) ||
      "Combined IIIF manifests generated from " +
        sortedSeries.length +
        " Stanford EarthWorks Gaihozu index-map records, nested by all series, broad region, scale, theme, subject, and decade.",
    metadata: [
      metadataPair("Series in collection", String(sortedSeries.length)),
      ...collectionMetadata,
    ],
    requiredStatement: {
      label: languageMap("Source"),
      value: languageMap(
        "Metadata from Stanford EarthWorks and OpenGeoMetadata. Sheet images and IIIF manifests are served by Stanford PURL.",
      ),
    },
    homepage: [
      {
        id: earthworksUrl(collectionId),
        type: "Text",
        label: languageMap("EarthWorks collection"),
        format: "text/html",
      },
    ],
    items: [allSeries, byRegion, byScale, byTheme, bySubject, byDecade],
  });
}

function buildGroupingCollection({
  id,
  label,
  summary,
  basePath,
  series,
  groupsForSeries,
  compareGroups = (left, right) => left.localeCompare(right, "en", { numeric: true }),
  collectionRecord,
}) {
  const groups = new Map();
  for (const item of series) {
    for (const group of groupsForSeries(item)) {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(item.ref);
    }
  }

  const items = [...groups]
    .sort(([left], [right]) => compareGroups(left, right))
    .map(([group, refs]) =>
      buildCollection({
        id: baseUrl + "/iiif/collections/" + basePath + "/" + slugify(group) + ".json",
        label: group,
        summary: refs.length + " series.",
        metadata: collectionViewMetadata(collectionRecord, [
          metadataPair("Collection view", label),
          metadataPair("Group", group),
          metadataPair("Series in group", String(refs.length)),
        ]),
        items: refs,
      }),
    );

  return buildCollection({
    id,
    label,
    summary,
    metadata: collectionViewMetadata(collectionRecord, [
      metadataPair("Collection view", label),
      metadataPair("Groups in view", String(items.length)),
    ]),
    items,
  });
}

function buildCollection({ id, label, summary, metadata, requiredStatement, homepage, items }) {
  return compactObject({
    "@context": iiifPresentationContext,
    id,
    type: "Collection",
    label: languageMap(label),
    summary: languageMap(summary),
    metadata,
    requiredStatement,
    homepage,
    items,
  });
}

async function writeCollectionTree(collection) {
  if (collection.type !== "Collection") return;
  await writeJson(localPathForUrl(collection.id), collection);
  for (const item of array(collection.items)) {
    if (item.type === "Collection") {
      await writeCollectionTree(item);
    }
  }
}

function localPathForUrl(url) {
  let pathname = new URL(url).pathname;
  if (basePath && pathname.startsWith(basePath + "/")) {
    pathname = pathname.slice(basePath.length);
  }
  if (!pathname.startsWith("/iiif/")) {
    throw new Error("Refusing to write collection outside /iiif/: " + url);
  }
  return path.join(staticDir, pathname.replace(/^\//, ""));
}

function manifestReference(manifest, record, sheets, { regions, scales } = {}) {
  const scaleLabels = scales || scalesForRecord(record, manifest);
  const regionLabels = regions || regionsForRecord(record, manifest);
  const seriesDruid = normalizeBareDruid(record.id || druidFromManifestUrl(manifest.id) || manifest.id);
  return compactObject({
    id: manifest.id,
    type: "Manifest",
    label: manifest.label,
    summary: manifest.summary,
    thumbnail: manifest.thumbnail,
    navDate: manifest.navDate,
    metadata: buildSeriesReferenceMetadata(record, {
      regions: regionLabels,
      scales: scaleLabels,
    }),
    homepage: manifest.homepage,
    seeAlso: manifest.seeAlso,
  });
}

function collectionViewMetadata(record, extra = []) {
  return [...extra, ...metadataPairsFromRecord(record, { collectionLabels })];
}

function buildSeriesReferenceMetadata(record, { regions = [], scales = [] } = {}) {
  return [
    metadataPair("EarthWorks ID", record.id),
    metadataPair("Scale", scales),
    metadataPair("Broad region", regions),
  ];
}

function buildSeriesMetadata(record, seriesDruid, sheets, manifest, { regions = [], scales = [] } = {}) {
  return [
    metadataPair("Scale", scales),
    metadataPair("Broad region", regions),
    ...metadataPairsFromRecord(record, { collectionLabels }),
  ];
}

function seriesSeeAlsoResources(seriesDruid) {
  return [
    {
      id: baseUrl + "/geojson/" + seriesDruid + ".geojson",
      type: "Dataset",
      label: languageMap("Sheet index GeoJSON"),
      format: "application/geo+json",
    },
    {
      id: baseUrl + "/iiif/series/" + seriesDruid + "/sheets.json",
      type: "Dataset",
      label: languageMap("Extracted sheet manifest URLs"),
      format: "application/json",
    },
  ];
}

function canvasSeeAlsoResources(record, seriesDruid) {
  return dedupeResources([
    {
      id: baseUrl + "/geojson/" + seriesDruid + ".geojson",
      type: "Dataset",
      label: languageMap("Sheet index GeoJSON"),
      format: "application/geo+json",
    },
    ...assetLinksFromRecord(record),
  ]);
}

function dedupeResources(resources) {
  const seen = new Set();
  return resources.filter((resource) => {
    if (!resource?.id || seen.has(resource.id)) return false;
    seen.add(resource.id);
    return true;
  });
}

function unionSheetsNavPlace(sheets, seriesDruid, title) {
  const features = sheets.flatMap((sheet) => array(sheet.navPlace?.features));
  return unionNavPlaceFeatures(features, {
    id: baseUrl + "/iiif/series/" + seriesDruid + "/manifest.json#navplace",
    label: title,
    properties: {
      seriesDruid,
      sheetCount: sheets.length,
      sourceFeatureCount: features.length,
    },
  });
}

function unionNavPlaceFeatures(features, { id, label, properties = {} }) {
  const geometries = features.flatMap((feature) => clippingGeometries(feature?.geometry));
  if (geometries.length === 0) return undefined;

  try {
    const accumulator = unionClippingGeometries(geometries);
    if (!accumulator?.length) return undefined;
    const geometry = geometryFromClippingAccumulator(accumulator);
    const feature = compactObject({
      id: id + "-feature",
      type: "Feature",
      properties: compactObject({
        label: languageMap(label),
        ...properties,
      }),
      geometry,
      bbox: geometryBbox(geometry),
    });
    return compactObject({
      id,
      type: "FeatureCollection",
      features: [feature],
      bbox: feature.bbox,
    });
  } catch (error) {
    console.warn(
      "Unable to union navPlace geometry for " +
        id +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
    return undefined;
  }
}

function unionClippingGeometries(geometries) {
  const chunkSize = 250;
  const [firstGeometry, ...remainingGeometries] = geometries;
  let accumulator = unionPolygons(firstGeometry);
  for (let index = 0; index < remainingGeometries.length; index += chunkSize) {
    accumulator = unionPolygons(accumulator, ...remainingGeometries.slice(index, index + chunkSize));
  }
  return accumulator;
}

function clippingGeometries(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return [geometry.coordinates];
  if (geometry.type === "GeometryCollection") {
    return array(geometry.geometries).flatMap(clippingGeometries);
  }
  return [];
}

function geometryFromClippingAccumulator(accumulator) {
  return accumulator.length === 1
    ? {
        type: "Polygon",
        coordinates: accumulator[0],
      }
    : {
        type: "MultiPolygon",
        coordinates: accumulator,
      };
}

function mergeContexts(existing, required) {
  const current = array(existing);
  return [
    ...required,
    ...current.filter((context) => context && !required.includes(context)),
  ];
}

function sheetManifestUrlFromCanvas(canvas) {
  for (const pair of array(canvas.metadata)) {
    if (/sheet manifest/i.test(label(pair.label))) {
      const text = label(pair.value);
      if (text) return text;
    }
  }
  for (const part of array(canvas.partOf)) {
    if (part?.type === "Manifest" && part.id) return part.id;
  }
  return "";
}

function appendNavPlaceFeature(sheet, feature) {
  if (!feature) return;
  if (!sheet.navPlace) {
    const key = sheet.recid || "feature-" + sheet.featureIndex;
    sheet.navPlace = {
      id:
        baseUrl +
        "/iiif/series/" +
        feature.seriesDruid +
        "/manifest.json#navplace-" +
        key,
      type: "FeatureCollection",
      features: [],
    };
  }

  const { seriesDruid: _seriesDruid, ...geojsonFeature } = feature;
  sheet.navPlace.features.push(geojsonFeature);
  sheet.navPlace.bbox = combineBboxes(sheet.navPlace.bbox, geojsonFeature.bbox);
}

function navPlaceFeatureFromSheetFeature({
  seriesDruid,
  feature,
  featureIndex,
  label,
  manifestUrl,
  recid,
  callNumber,
}) {
  if (!feature?.geometry) return null;

  const geometry = structuredClone(feature.geometry);
  const bbox = geometryBbox(geometry);
  const key = recid || "feature-" + featureIndex;
  return compactObject({
    seriesDruid,
    id:
      baseUrl +
      "/iiif/series/" +
      seriesDruid +
      "/manifest.json#navplace-" +
      key +
      "-feature-" +
      featureIndex,
    type: "Feature",
    properties: compactObject({
      label: languageMap(label),
      manifestUrl,
      recid,
      callNumber,
      sourceFeatureIndex: featureIndex,
    }),
    geometry,
    bbox,
  });
}

function geometryBbox(geometry) {
  if (!geometry) return undefined;
  const bbox = emptyBbox();
  if (geometry.type === "GeometryCollection") {
    for (const child of array(geometry.geometries)) {
      extendBbox(bbox, geometryBbox(child));
    }
  } else {
    extendBboxFromCoordinates(bbox, geometry.coordinates);
  }
  return bbox.valid ? [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] : undefined;
}

function extendBboxFromCoordinates(bbox, coordinates) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    extendBbox(bbox, [coordinates[0], coordinates[1], coordinates[0], coordinates[1]]);
    return;
  }

  for (const child of coordinates) {
    extendBboxFromCoordinates(bbox, child);
  }
}

function combineBboxes(left, right) {
  const bbox = emptyBbox();
  extendBbox(bbox, left);
  extendBbox(bbox, right);
  return bbox.valid ? [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] : undefined;
}

function extendBbox(target, bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return;
  const [minX, minY, maxX, maxY] = bbox.map(Number);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
  target.minX = Math.min(target.minX, minX);
  target.minY = Math.min(target.minY, minY);
  target.maxX = Math.max(target.maxX, maxX);
  target.maxY = Math.max(target.maxY, maxY);
  target.valid = true;
}

function emptyBbox() {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    valid: false,
  };
}

function extractSheets(geojson, seriesDruid) {
  const seen = new Map();
  for (const [featureIndex, feature] of array(geojson.features).entries()) {
    const properties = feature?.properties || {};
    const manifestUrl = findManifestUrl(properties);
    if (!manifestUrl) continue;

    const sheetLabel =
      stringValue(properties.label) ||
      stringValue(properties.Sheet_ID) ||
      stringValue(properties.sheet_id) ||
      stringValue(properties.name) ||
      manifestUrl;
    const recid = stringValue(properties.recid) || druidFromManifestUrl(manifestUrl);
    const callNumber = stringValue(properties.call_num);
    const navFeature = navPlaceFeatureFromSheetFeature({
      seriesDruid,
      feature,
      featureIndex,
      label: sheetLabel,
      manifestUrl,
      recid,
      callNumber,
    });

    if (seen.has(manifestUrl)) {
      appendNavPlaceFeature(seen.get(manifestUrl), navFeature);
      continue;
    }

    const sheet = {
      label: sheetLabel,
      manifestUrl,
      recid,
      websiteUrl: stringValue(properties.websiteUrl),
      callNumber,
      featureIndex,
    };
    appendNavPlaceFeature(sheet, navFeature);
    seen.set(manifestUrl, sheet);
  }
  return [...seen.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "en", { numeric: true }),
  );
}

function findManifestUrl(value) {
  const manifestPattern = new RegExp(
    "https://purl\\.stanford\\.edu/[a-z]{2}\\d{3}[a-z]{2}\\d{4}/iiif3?/manifest",
    "i",
  );
  for (const text of deepStrings(value)) {
    const match = text.match(manifestPattern);
    if (match) return match[0].replace("/iiif3/", "/iiif/");
  }

  const recid = stringValue(value.recid) || stringValue(value.druid);
  if (stanfordDruidPattern().test(recid)) {
    return "https://purl.stanford.edu/" + recid + "/iiif/manifest";
  }

  const website = stringValue(value.websiteUrl) || stringValue(value.website_url);
  const druid = website.match(new RegExp("purl\\.stanford\\.edu/([a-z]{2}\\d{3}[a-z]{2}\\d{4})", "i"));
  if (druid) return "https://purl.stanford.edu/" + druid[1] + "/iiif/manifest";

  return null;
}

function stanfordDruidPattern() {
  return new RegExp("^[a-z]{2}\\d{3}[a-z]{2}\\d{4}$", "i");
}

function regionsForRecord(record, manifest, fallbackTitle = "") {
  const metadataRegions = metadataValues(manifest, "Broad region");
  if (metadataRegions.length) return metadataRegions;

  const spatial = array(record.dct_spatial_sm);
  const text = (spatial.join(" | ") + " | " + (record.dct_title_s || fallbackTitle)).toLowerCase();
  const regions = [];
  const add = (label, pattern) => {
    if (new RegExp(pattern, "iu").test(text)) regions.push(label);
  };

  add("Japan", "\\bjapan\\b|nippon|nihon|tokyo|yokohama|osaka|kyushu|kyūshū|honshu|hokkaido|okinawa|ryukyu|towada|tokuyama|tsuruga|mie|yokkaichi|kuwana|kawasaki");
  add("Karafuto, Sakhalin, and Kurils", "karafuto|sakhalin|kuril|chishima|sahalin|saharen");
  add("Korea", "korea|chōsen|chosen|fuzan|keijō|heijō|rashin|seishin|chinkai|fusan");
  add("Taiwan", "taiwan|taihoku|taihokufu|formosa|臺灣|台湾");
  add("Manchuria and Northeast China", "manchuria|mansh|dalian|liaoning|jilin|changchun|harbin|heihe|heilongjiang|amur river|inner mongolia|daikōanrei|hsinking|shinkyō");
  add("China and Mongolia", "\\bchina\\b|shina|yunnan|anhui|jiangxi|shanghai|beijing|sichuan|xinjiang|fukien|fujian|mongolia|mongol|shaanxi|kansu|gansu|hankou|chengdu");
  add("Russian Far East and Siberia", "russia|russian|siberia|primors|khabarovsk|zaba|kamchatka|okhotsk|nikolaevsk|vladivostok|ulan-ude|nerchinsk|komsomolsk|blagoveshchensk|birobid|ussuri|transbaikal");
  add("Southeast Asia", "southeast asia|thailand|indochina|vietnam|laos|cambodia|burma|myanmar|philippines|luzon|dutch east indies|indonesia|borneo|celebes|sumatra|java|timor|halmahera|taninbar|mentawei|nicobar|malay|singapore|davao|panay|pantar|rot[ai]");
  add("Pacific and Oceania", "pacific|south seas|mariana|marshall|caroline|palau|chuuk|ponape|saipan|guam|nauru|ocean island|new guinea|papua|bismarck|solomon|admiralty|rabaul|bougainville|new georgia|angaur");
  add("South Asia", "\\bindia\\b|indo(?!china)|south asia");
  add("Europe and Eurasia Overview", "europe|eurasia|yōroppa|ōa|european russia");
  add("Overview and Multi-region", "east asia|\\basia\\b|colonies|world|aviation|aeronautical|million|太平洋|東亞|百萬|百万");

  if (regions.length === 0) regions.push("Other / Local Places");
  return [...new Set(regions)];
}

function subjectsForRecord(record) {
  const subjects = array(record.dct_subject_sm)
    .map((subject) => String(subject || "").trim())
    .filter(Boolean);
  return subjects.length ? [...new Set(subjects)] : ["Unspecified subject"];
}

function themesForRecord(record) {
  const themes = array(record.dcat_theme_sm)
    .map((theme) => String(theme || "").trim())
    .filter(Boolean);
  return themes.length ? [...new Set(themes)] : ["Unspecified theme"];
}

function scalesForRecord(record, manifest, fallbackTitle = "") {
  const metadataScales = metadataValues(manifest, "Scale");
  if (metadataScales.length) return metadataScales;

  const title = record.dct_title_s || fallbackTitle;
  const scalePattern = new RegExp("1\\s*:\\s*([0-9][0-9,]*)", "g");
  const scales = [...title.matchAll(scalePattern)].map((match) => formatScale(match[1]));
  return scales.length ? [...new Set(scales)] : ["Unknown scale"];
}

function metadataValues(manifest, labelText) {
  const pair = array(manifest?.metadata).find((item) => label(item.label) === labelText);
  return label(pair?.value)
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatScale(value) {
  const denominator = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(denominator)
    ? "1:" + denominator.toLocaleString("en-US")
    : "1:" + value;
}

function compareScaleLabels(left, right) {
  return scaleNumber(left) - scaleNumber(right) || left.localeCompare(right, "en");
}

function compareDecadeLabels(left, right) {
  return decadeNumber(left) - decadeNumber(right) || left.localeCompare(right, "en");
}

function decadeNumber(label) {
  const match = String(label).match(new RegExp("([0-9]{4})s"));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function scaleNumber(label) {
  const match = String(label).match(new RegExp("1:([0-9,]+)"));
  return match ? Number(match[1].replace(/,/g, "")) : Number.MAX_SAFE_INTEGER;
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .replace(new RegExp("[^a-z0-9]+", "g"), "-")
    .replace(new RegExp("^-+|-+$", "g"), "") || "group";
}

function normalizeManifestUrl(value) {
  return String(value || "").replace("/iiif3/", "/iiif/").replace(new RegExp("/+$"), "");
}

function normalizeStanfordId(value) {
  const bare = normalizeBareDruid(value);
  return bare ? "stanford-" + bare : String(value);
}

function earthworksUrl(id) {
  return "https://earthworks.stanford.edu/catalog/" + id;
}

function druidFromManifestUrl(url) {
  return String(url || "").match(new RegExp("purl\\.stanford\\.edu/([a-z]{2}\\d{3}[a-z]{2}\\d{4})", "i"))?.[1];
}

function* deepStrings(value) {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* deepStrings(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* deepStrings(item);
  }
}

function metadataPair(label, value) {
  return {
    label: languageMap(label),
    value: languageMap(value),
  };
}

function languageMap(value) {
  const values = languageValues(value);
  return { none: values.length ? values : [""] };
}

function languageValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => languageValues(item)).filter(Boolean);
  const text = typeof value === "string" ? value.trim() : String(value);
  return text ? [text] : [];
}

function label(map) {
  if (!map) return "";
  if (typeof map === "string") return map;
  return map.en?.[0] || map.none?.[0] || Object.values(map)[0]?.[0] || "";
}

function array(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeBareDruid(value) {
  return String(value)
    .replace(/^druid:/, "")
    .replace(/^stanford-/, "")
    .trim();
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, inline] = token.slice(2).split("=", 2);
    const value =
      inline !== undefined
        ? inline
        : argv[index + 1] && !argv[index + 1].startsWith("--")
          ? argv[++index]
          : true;
    parsed[rawKey] = value;
  }
  return parsed;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(file + ".tmp", file);
}

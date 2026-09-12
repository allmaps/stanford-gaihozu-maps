#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { featureCollection } from "@turf/helpers";
import clipping from "polygon-clipping";
import { geojson as fgbGeojson } from "flatgeobuf";
import { fetch as fetchIiif } from "@iiif/helpers/fetch";
import shp from "shpjs";

const rootDir = process.cwd();
const args = parseArgs(process.argv.slice(2));
const collectionId = normalizeStanfordId(
  args["collection-id"] || process.env.COLLECTION_ID || "stanford-ch237ht4777",
);
const collectionDruid = collectionId.replace(/^stanford-/, "");
const metadataDir = path.resolve(
  args["metadata-dir"] ||
    process.env.OPEN_GEOMETADATA_DIR ||
    ".cache/opengeometadata/edu.stanford.purl",
);
const cacheDir = path.resolve(args["cache-dir"] || ".cache/http");
const baseUrl = trimTrailingSlash(
  args["base-url"] || process.env.BASE_URL || "http://localhost:5173",
);
const delayMs = Number(args["delay-ms"] || process.env.REQUEST_DELAY_MS || 750);
const limitSeries = numberOption(args["limit-series"]);
const limitSheets = numberOption(args["limit-sheets"]);
const skipManifests = Boolean(args["skip-manifests"]);
const dryRun = Boolean(args["dry-run"]);
const selectedSeries = setOption(args["series-id"]).map(normalizeBareDruid);
const publicDir = path.resolve("public");
const dataDir = path.resolve("data");
const navPlaceContext = "http://iiif.io/api/extension/navplace/context.json";
const iiifPresentationContext = "http://iiif.io/api/presentation/3/context.json";
const nativeFetch = globalThis.fetch.bind(globalThis);
const hostLastFetch = new Map();
const { union: unionPolygons } = clipping;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const headers = new Headers(init.headers || {});
  const accept = headers.get("accept") || "application/json";
  const { buffer, contentType, finalUrl } = await cachedFetch(url, { accept });
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": contentType || "application/json",
      "x-cache-url": finalUrl || url,
    },
  });
};

await main();

async function main() {
  const metadataRoot = path.join(metadataDir, "metadata-aardvark");
  if (!existsSync(metadataRoot)) {
    throw new Error(
      `OpenGeoMetadata checkout not found at ${metadataDir}. Run pnpm run metadata:sync first.`,
    );
  }

  await mkdir(cacheDir, { recursive: true });
  await mkdir(path.join(publicDir, "geojson"), { recursive: true });
  await mkdir(path.join(publicDir, "iiif", "series"), { recursive: true });
  await mkdir(path.join(dataDir, "index-records"), { recursive: true });

  const allRecords = await discoverSeries(metadataRoot, collectionId);
  const records = allRecords
    .filter((record) => {
      if (selectedSeries.length === 0) return true;
      return selectedSeries.includes(recordBareDruid(record));
    })
    .slice(0, limitSeries || undefined);

  console.log(`Found ${allRecords.length} series records in ${collectionId}.`);
  console.log(`Building ${records.length} series records.`);
  console.log(
    `Request delay: ${delayMs}ms per host. HTTP cache: ${path.relative(rootDir, cacheDir)}`,
  );

  const collectionItems = [];
  const report = {
    generatedAt: new Date().toISOString(),
    collectionId,
    baseUrl,
    delayMs,
    seriesFound: allRecords.length,
    seriesBuilt: records.length,
    skipManifests,
    phases: ["geojson", skipManifests ? "manifest-stubs" : "manifests"],
    series: [],
  };

  console.log("Phase 1/2: fetching and saving all GeoJSON sheet indices.");
  const preparedSeries = [];
  for (const [index, record] of records.entries()) {
    const prepared = await prepareSeries(record, index + 1, records.length);
    report.series.push(prepared.report);
    if (prepared.status === "ok") {
      preparedSeries.push(prepared);
    }
    await writeBuildReport(report);
  }

  console.log(
    `Phase 1 complete: ${preparedSeries.length}/${records.length} GeoJSON indices ready.`,
  );

  if (skipManifests) {
    console.log("Skipping sheet manifests by request.");
  } else {
    console.log("Phase 2/2: fetching IIIF sheet manifests and combining canvases.");
  }

  for (const [index, prepared] of preparedSeries.entries()) {
    const item = await buildSeriesManifestFile(
      prepared,
      index + 1,
      preparedSeries.length,
    );
    if (item) {
      collectionItems.push(item);
    }
    await writeCollectionAndReport(collectionItems, allRecords.length, report);
  }

  await writeCollectionAndReport(collectionItems, allRecords.length, report);
  console.log(`Wrote ${collectionItems.length} collection manifest entries.`);
  console.log(`Collection: ${baseUrl}/iiif/collection.json`);
}

async function prepareSeries(record, ordinal, total) {
  const seriesDruid = recordBareDruid(record);
  const title = record.dct_title_s || seriesDruid;
  const refs = parseReferences(record);
  const report = {
    id: record.id,
    title,
    geojson: null,
    sheets: 0,
    canvases: 0,
    failedSheets: [],
    status: "pending",
  };

  console.log(`[geojson ${ordinal}/${total}] ${seriesDruid}: ${title}`);

  try {
    if (!dryRun) {
      await writeJson(
        path.join(dataDir, "index-records", `${seriesDruid}.json`),
        record,
      );
    }

    const geojsonInfo = await saveGeojson(seriesDruid, refs);
    report.geojson = geojsonInfo.url;
    const geojson = JSON.parse(
      geojsonInfo.text || (await readFile(geojsonInfo.localPath, "utf8")),
    );
    const sheets = extractSheets(geojson, seriesDruid).slice(0, limitSheets || undefined);
    report.sheets = sheets.length;
    report.status = "geojson-ready";

    const seriesDir = path.join(publicDir, "iiif", "series", seriesDruid);
    if (!dryRun) {
      await mkdir(seriesDir, { recursive: true });
      await writeJson(path.join(seriesDir, "sheets.json"), {
        id: `${baseUrl}/iiif/series/${seriesDruid}/sheets.json`,
        type: "Dataset",
        label: title,
        sourceGeojson: `${baseUrl}/geojson/${seriesDruid}.geojson`,
        sheets,
      });
    }

    return {
      status: "ok",
      record,
      seriesDruid,
      title,
      refs,
      sheets,
      report,
    };
  } catch (error) {
    report.status = "geojson-failed";
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`[geojson ${ordinal}/${total}] ${seriesDruid} failed: ${report.error}`);
    return {
      status: "failed",
      record,
      seriesDruid,
      title,
      refs,
      sheets: [],
      report,
    };
  }
}

async function buildSeriesManifestFile(prepared, ordinal, total) {
  const { record, seriesDruid, title, refs, sheets, report } = prepared;
  const canvases = [];

  console.log(
    `[manifests ${ordinal}/${total}] ${seriesDruid}: ${sheets.length} sheet manifests`,
  );

  if (!skipManifests) {
    for (const [sheetIndex, sheet] of sheets.entries()) {
      try {
        if (sheetIndex === 0 || (sheetIndex + 1) % 25 === 0 || sheetIndex + 1 === sheets.length) {
          console.log(
            `  ${seriesDruid}: sheet ${sheetIndex + 1}/${sheets.length} ${sheet.label}`,
          );
        }
        const manifest = await fetchIiif(sheet.manifestUrl);
        const manifestCanvases = Array.isArray(manifest?.items)
          ? manifest.items
          : [];
        for (const canvas of manifestCanvases) {
          canvases.push(enrichCanvas(canvas, sheet, sheetIndex));
        }
      } catch (error) {
        report.failedSheets.push({
          manifestUrl: sheet.manifestUrl,
          label: sheet.label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  report.canvases = canvases.length;
  report.status = skipManifests
    ? "manifest-stub-written"
    : report.failedSheets.length > 0
      ? "manifests-written-with-errors"
      : "manifests-written";

  const seriesDir = path.join(publicDir, "iiif", "series", seriesDruid);
  const manifestPath = path.join(seriesDir, "manifest.json");
  const manifestUrl = `${baseUrl}/iiif/series/${seriesDruid}/manifest.json`;
  const manifest = buildSeriesManifest(record, seriesDruid, sheets, canvases);
  if (!dryRun) {
    await writeJson(manifestPath, manifest);
  }

  return {
    id: manifestUrl,
    type: "Manifest",
    label: languageMap(title),
    summary: languageMap(summaryText(record)),
    thumbnail: thumbnail(refs),
    metadata: [
      metadataPair("Series DRUID", seriesDruid),
      metadataPair("Available sheets", String(sheets.length)),
      metadataPair("Combined canvases", String(canvases.length)),
    ],
    homepage: [
      {
        id: earthworksUrl(record.id),
        type: "Text",
        label: languageMap("EarthWorks record"),
        format: "text/html",
      },
    ],
    seeAlso: [
      {
        id: `${baseUrl}/geojson/${seriesDruid}.geojson`,
        type: "Dataset",
        label: languageMap("Sheet index GeoJSON"),
        format: "application/geo+json",
      },
    ],
  };
}

async function writeCollectionAndReport(collectionItems, totalSeries, report) {
  if (dryRun) return;
  const collection = buildCollection(collectionItems, totalSeries);
  await writeJson(path.join(publicDir, "iiif", "collection.json"), collection);
  await writeBuildReport(report);
}

async function writeBuildReport(report) {
  if (dryRun) return;
  await writeJson(path.join(dataDir, "build-report.json"), report);
}

async function saveGeojson(seriesDruid, refs) {
  const localPath = path.join(publicDir, "geojson", `${seriesDruid}.geojson`);
  const directUrl = directGeojsonUrl(refs);
  if (directUrl) {
    const { buffer } = await cachedFetch(directUrl, {
      accept: "application/geo+json,application/json;q=0.9,*/*;q=0.5",
    });
    if (!dryRun) {
      await writeFile(localPath, buffer);
    }
    return { localPath, url: directUrl, text: buffer.toString("utf8") };
  }

  const zipUrl = downloadUrl(refs);
  if (!zipUrl) {
    throw new Error(`No GeoJSON or zipped object URL found for ${seriesDruid}`);
  }

  const { buffer } = await cachedFetch(zipUrl, {
    accept: "application/zip,*/*;q=0.5",
  });
  const files = unzipSync(new Uint8Array(buffer));
  const geojsonName =
    Object.keys(files).find((name) => /(^|\/)index_map\.geojson$/i.test(name)) ||
    Object.keys(files).find((name) => /\.geojson$/i.test(name));

  if (geojsonName) {
    const text = Buffer.from(files[geojsonName]).toString("utf8");
    if (!dryRun) {
      await writeFile(localPath, text);
    }
    return {
      localPath,
      url: `${zipUrl}#${geojsonName}`,
      text,
    };
  }

  const shapefileGroup = findShapefileGroup(files);
  if (shapefileGroup) {
    const geojson = await shapefileToGeojson(shapefileGroup);
    const text = `${JSON.stringify(geojson)}\n`;
    if (!dryRun) {
      await writeFile(localPath, text);
    }
    return {
      localPath,
      url: `${zipUrl}#${shapefileGroup.baseName}.shp`,
      text,
    };
  }

  const fgbName =
    Object.keys(files).find((name) => /(^|\/)index_map\.fgb$/i.test(name)) ||
    Object.keys(files).find((name) => /\.fgb$/i.test(name));

  if (!fgbName) {
    throw new Error(`No GeoJSON, shapefile, or FlatGeobuf file found inside ${zipUrl}`);
  }

  const featureCollection = await flatgeobufToGeojson(files[fgbName]);
  const text = `${JSON.stringify(featureCollection)}\n`;
  if (!dryRun) {
    await writeFile(localPath, text);
  }
  return {
    localPath,
    url: `${zipUrl}#${fgbName}`,
    text,
  };
}

function findShapefileGroup(files) {
  const groups = new Map();
  const allowedExtensions = new Set([".shp", ".shx", ".dbf", ".prj", ".cpg"]);

  for (const [name, bytes] of Object.entries(files)) {
    if (/^__MACOSX\//i.test(name)) continue;
    const normalizedName = name.replaceAll("\\", "/");
    const extension = path.posix.extname(normalizedName).toLowerCase();
    if (!allowedExtensions.has(extension)) continue;

    const baseName = normalizedName.slice(0, -extension.length);
    const group = groups.get(baseName) || { baseName, files: {} };
    group.files[extension.slice(1)] = bytes;
    groups.set(baseName, group);
  }

  return [...groups.values()]
    .filter((group) => group.files.shp && group.files.dbf)
    .sort(compareShapefileGroups)[0];
}

function compareShapefileGroups(left, right) {
  return (
    shapefileGroupScore(left) - shapefileGroupScore(right) ||
    left.baseName.length - right.baseName.length ||
    left.baseName.localeCompare(right.baseName, "en")
  );
}

function shapefileGroupScore(group) {
  const basename = path.posix.basename(group.baseName).toLowerCase();
  if (basename === "index_map") return 0;
  if (basename.includes("index") && basename.includes("map")) return 1;
  if (basename.includes("index")) return 2;
  return 3;
}

async function shapefileToGeojson(group) {
  const input = {
    shp: bytesToArrayBuffer(group.files.shp),
    dbf: bytesToArrayBuffer(group.files.dbf),
  };

  if (group.files.prj) {
    input.prj = bytesToText(group.files.prj);
  }
  if (group.files.cpg) {
    input.cpg = bytesToText(group.files.cpg).trim();
  }

  const parsed = await shp(input);
  return normalizeFeatureCollection(parsed, group.baseName);
}

function normalizeFeatureCollection(geojson, name = "index_map") {
  const collection = Array.isArray(geojson)
    ? geojson.find((item) => item?.type === "FeatureCollection") || geojson[0]
    : geojson;

  if (!collection || collection.type !== "FeatureCollection") {
    throw new Error(`Shapefile ${name} did not convert to a FeatureCollection`);
  }

  const normalized = featureCollection(
    array(collection.features).map((feature) => ({
      type: "Feature",
      properties: feature?.properties || {},
      geometry: feature?.geometry || null,
      ...(feature?.id === undefined ? {} : { id: feature.id }),
    })),
  );
  normalized.name = path.posix.basename(name);
  if (collection.bbox) normalized.bbox = collection.bbox;
  return normalized;
}

function bytesToArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

async function flatgeobufToGeojson(bytes) {
  const features = [];
  for await (const feature of fgbGeojson.deserialize(new Uint8Array(bytes))) {
    features.push(feature);
  }
  return {
    type: "FeatureCollection",
    name: "index_map",
    features,
  };
}

async function discoverSeries(metadataRoot, memberOfId) {
  const records = [];
  for await (const file of walk(metadataRoot)) {
    if (!file.endsWith("geoblacklight.json")) continue;
    const record = JSON.parse(await readFile(file, "utf8"));
    const memberOf = array(record.pcdm_memberOf_sm);
    if (memberOf.includes(memberOfId)) {
      records.push(record);
    }
  }

  records.sort((a, b) => {
    const left = `${a.dct_title_s || ""} ${a.id}`;
    const right = `${b.dct_title_s || ""} ${b.id}`;
    return left.localeCompare(right, "en");
  });
  return records;
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function cachedFetch(url, { accept = "*/*" } = {}) {
  const key = crypto.createHash("sha256").update(url).digest("hex");
  const bodyPath = path.join(cacheDir, `${key}.body`);
  const metaPath = path.join(cacheDir, `${key}.json`);

  if (existsSync(bodyPath) && existsSync(metaPath)) {
    const [buffer, meta] = await Promise.all([
      readFile(bodyPath),
      readFile(metaPath, "utf8").then(JSON.parse),
    ]);
    return { buffer, ...meta, fromCache: true };
  }

  await waitForHost(url);
  const response = await nativeFetch(url, {
    headers: {
      accept,
      "user-agent":
        "gaihozu-maps-builder/0.1 (research script; contact via Stanford PURL metadata)",
    },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const meta = {
    url,
    finalUrl: response.url,
    fetchedAt: new Date().toISOString(),
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
  };
  await writeFile(bodyPath, buffer);
  await writeJson(metaPath, meta);
  return { buffer, ...meta, fromCache: false };
}

async function waitForHost(url) {
  const host = new URL(url).host;
  const previous = hostLastFetch.get(host) || 0;
  const wait = previous + delayMs - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  hostLastFetch.set(host, Date.now());
}

function buildSeriesManifest(record, seriesDruid, sheets, canvases) {
  const title = record.dct_title_s || seriesDruid;
  const refs = parseReferences(record);
  return compactObject({
    "@context": [navPlaceContext, iiifPresentationContext],
    id: `${baseUrl}/iiif/series/${seriesDruid}/manifest.json`,
    type: "Manifest",
    label: languageMap(title),
    summary: languageMap(summaryText(record)),
    rights: publicDomainRights(record),
    behavior: ["individuals"],
    metadata: [
      metadataPair("Series DRUID", seriesDruid),
      metadataPair("EarthWorks ID", record.id),
      metadataPair("Available sheets", String(sheets.length)),
      metadataPair("Combined canvases", String(canvases.length)),
    ],
    homepage: [
      {
        id: earthworksUrl(record.id),
        type: "Text",
        label: languageMap("EarthWorks record"),
        format: "text/html",
      },
      {
        id: `https://purl.stanford.edu/${seriesDruid}`,
        type: "Text",
        label: languageMap("Stanford PURL"),
        format: "text/html",
      },
    ],
    seeAlso: [
      {
        id: `${baseUrl}/geojson/${seriesDruid}.geojson`,
        type: "Dataset",
        label: languageMap("Sheet index GeoJSON"),
        format: "application/geo+json",
      },
      {
        id: `${baseUrl}/iiif/series/${seriesDruid}/sheets.json`,
        type: "Dataset",
        label: languageMap("Extracted sheet manifest URLs"),
        format: "application/json",
      },
    ],
    thumbnail: thumbnail(refs),
    navPlace: unionSheetsNavPlace(sheets, seriesDruid, title),
    partOf: [
      {
        id: `${baseUrl}/iiif/collection.json`,
        type: "Collection",
        label: languageMap("Gaihozu Index Maps"),
      },
    ],
    items: canvases,
  });
}

function buildCollection(items, totalSeries) {
  return {
    id: `${baseUrl}/iiif/collection.json`,
    type: "Collection",
    label: languageMap("Gaihozu Index Maps"),
    summary: languageMap(
      `Combined IIIF manifests generated from ${items.length} of ${totalSeries} Stanford EarthWorks Gaihozu index-map records.`,
    ),
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
    items,
  };
}

function enrichCanvas(canvas, sheet, sheetIndex) {
  const clone = structuredClone(canvas);
  const existing = Array.isArray(clone.metadata) ? clone.metadata : [];
  clone.metadata = [
    ...existing,
    metadataPair("Sheet label", sheet.label),
    metadataPair("Sheet manifest", sheet.manifestUrl),
  ];
  if (sheet.navPlace) {
    clone.navPlace = mergeNavPlace(clone.navPlace, sheet.navPlace);
  }
  clone.navDate = clone.navDate || undefined;
  clone.behavior = clone.behavior || [];
  clone.annotations = clone.annotations || [];
  clone.rendering = array(clone.rendering);
  clone.seeAlso = array(clone.seeAlso);
  clone.partOf = [
    ...(Array.isArray(clone.partOf) ? clone.partOf : []),
    {
      id: sheet.manifestUrl,
      type: "Manifest",
      label: languageMap(sheet.label || `Sheet ${sheetIndex + 1}`),
    },
  ];
  return clone;
}

function mergeNavPlace(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return structuredClone(incoming);

  const merged = structuredClone(existing);
  const features = [
    ...array(merged.features),
    ...array(incoming.features).map((feature) => structuredClone(feature)),
  ];
  merged.type = "FeatureCollection";
  merged.features = features;
  merged.bbox = combineBboxes(merged.bbox, incoming.bbox);
  return merged;
}
function unionSheetsNavPlace(sheets, seriesDruid, title) {
  const features = sheets.flatMap((sheet) => array(sheet.navPlace?.features));
  return unionNavPlaceFeatures(features, {
    id: `${baseUrl}/iiif/series/${seriesDruid}/manifest.json#navplace`,
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
      id: `${id}-feature`,
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
      `Unable to union navPlace geometry for ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function unionClippingGeometries(geometries) {
  const chunkSize = 250;
  let accumulator = geometries[0];
  for (let index = 1; index < geometries.length; index += chunkSize) {
    accumulator = unionPolygons(accumulator, ...geometries.slice(index, index + chunkSize));
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


function appendNavPlaceFeature(sheet, feature) {
  if (!feature) return;
  if (!sheet.navPlace) {
    const key = sheet.recid || `feature-${sheet.featureIndex}`;
    sheet.navPlace = {
      id: `${baseUrl}/iiif/series/${feature.seriesDruid}/manifest.json#navplace-${key}`,
      type: "FeatureCollection",
      features: [],
    };
  }

  const { seriesDruid, ...geojsonFeature } = feature;
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
  const key = recid || `feature-${featureIndex}`;
  return compactObject({
    seriesDruid,
    id: `${baseUrl}/iiif/series/${seriesDruid}/manifest.json#navplace-${key}-feature-${featureIndex}`,
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

    const label =
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
      label,
      manifestUrl,
      recid,
      callNumber,
    });

    if (seen.has(manifestUrl)) {
      appendNavPlaceFeature(seen.get(manifestUrl), navFeature);
      continue;
    }

    const sheet = {
      label,
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
  for (const text of deepStrings(value)) {
    const match = text.match(
      /https:\/\/purl\.stanford\.edu\/[a-z]{2}\d{3}[a-z]{2}\d{4}\/iiif3?\/manifest/i,
    );
    if (match) return match[0].replace("/iiif3/", "/iiif/");
  }

  const recid = stringValue(value.recid) || stringValue(value.druid);
  if (/^[a-z]{2}\d{3}[a-z]{2}\d{4}$/i.test(recid)) {
    return `https://purl.stanford.edu/${recid}/iiif/manifest`;
  }

  const website = stringValue(value.websiteUrl) || stringValue(value.website_url);
  const druid = website.match(/purl\.stanford\.edu\/([a-z]{2}\d{3}[a-z]{2}\d{4})/i);
  if (druid) return `https://purl.stanford.edu/${druid[1]}/iiif/manifest`;

  return null;
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

function directGeojsonUrl(refs) {
  const direct = refs["https://openindexmaps.org"];
  if (typeof direct === "string" && /\.geojson($|\?)/i.test(direct)) {
    return direct;
  }
  for (const text of deepStrings(refs)) {
    if (/^https:\/\/.*\.geojson($|\?)/i.test(text)) {
      return text;
    }
  }
  return null;
}

function downloadUrl(refs) {
  const value = refs["http://schema.org/downloadUrl"];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") return first;
  if (first && typeof first.url === "string") return first.url;
  return null;
}

function parseReferences(record) {
  if (!record.dct_references_s) return {};
  try {
    return JSON.parse(record.dct_references_s);
  } catch {
    return {};
  }
}

function thumbnail(refs) {
  const id = refs["http://schema.org/thumbnailUrl"];
  if (!id) return undefined;
  return [
    {
      id,
      type: "Image",
      format: "image/jpeg",
    },
  ];
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
    if (parsed[rawKey]) {
      parsed[rawKey] = Array.isArray(parsed[rawKey])
        ? [...parsed[rawKey], value]
        : [parsed[rawKey], value];
    } else {
      parsed[rawKey] = value;
    }
  }
  return parsed;
}

function setOption(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) =>
    String(item)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function numberOption(value) {
  if (value === undefined || value === true) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function recordBareDruid(record) {
  return normalizeBareDruid(record.id || "");
}

function normalizeStanfordId(value) {
  const bare = normalizeBareDruid(value);
  return bare ? `stanford-${bare}` : String(value);
}

function normalizeBareDruid(value) {
  return String(value)
    .replace(/^druid:/, "")
    .replace(/^stanford-/, "")
    .trim();
}

function druidFromManifestUrl(url) {
  return url.match(/purl\.stanford\.edu\/([a-z]{2}\d{3}[a-z]{2}\d{4})/i)?.[1];
}

function earthworksUrl(id) {
  return `https://earthworks.stanford.edu/catalog/${id}`;
}

function array(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function summaryText(record) {
  return array(record.dct_description_sm).find(Boolean) || "";
}

function metadataPair(label, value) {
  return {
    label: languageMap(label),
    value: languageMap(value || ""),
  };
}

function languageMap(value) {
  return { none: [String(value || "")] };
}

function publicDomainRights(record) {
  const text = array(record.dct_rights_sm).join(" ");
  if (/public domain/i.test(text)) {
    return "http://creativecommons.org/publicdomain/mark/1.0/";
  }
  return undefined;
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

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

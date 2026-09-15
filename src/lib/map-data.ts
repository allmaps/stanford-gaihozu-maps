import type { Geometry } from "geojson";
import { publicPath } from "./iiif";
import type { SeriesIndex, SeriesIndexFeature, SeriesIndexProperties } from "./types";

export type Bbox = [number, number, number, number];

export async function fetchSeriesIndex(url = publicPath("/iiif/series-index.geojson")) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(url + " returned " + String(response.status));
  }
  return response.json() as Promise<SeriesIndex>;
}

export function featureId(feature: SeriesIndexFeature) {
  return feature.id ?? feature.properties?.id ?? feature.properties?.seriesDruid ?? "";
}

export function featureLabel(feature?: SeriesIndexFeature | null) {
  return feature?.properties?.label || String(feature ? featureId(feature) : "");
}

export function featureMatches(feature: SeriesIndexFeature, region: string, scale: string) {
  const properties = feature.properties || {};
  const regions = propertyList(properties.regions);
  const scales = propertyList(properties.scales);
  const regionMatch = region === "All regions" || regions.includes(region);
  const scaleMatch = scale === "All scales" || scales.includes(scale);
  return regionMatch && scaleMatch;
}

export function featureById(features: SeriesIndexFeature[], id: string | number | null) {
  if (id === null || id === "") return null;
  return features.find((feature) => String(featureId(feature)) === String(id)) || null;
}

export function uniquePropertyValues(features: SeriesIndexFeature[], key: keyof SeriesIndexProperties) {
  const values = new Set<string>();
  for (const feature of features) {
    for (const value of propertyList(feature.properties?.[key])) values.add(value);
  }
  const sorted = [...values];
  sorted.sort(key === "scales" ? compareScaleLabels : (left, right) => left.localeCompare(right, "en", { numeric: true }));
  return sorted;
}

export function propertyList(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function featureBbox(feature: SeriesIndexFeature) {
  if (Array.isArray(feature.bbox) && feature.bbox.length >= 4) return feature.bbox as Bbox;
  if (feature.geometry) return bboxForFeatures([feature]);
  return undefined;
}

export function featureIntersectsBbox(feature: SeriesIndexFeature, viewport: Bbox | null) {
  if (!viewport) return true;
  const bbox = featureBbox(feature);
  if (!bbox) return false;
  const latitudeIntersects = bbox[1] <= viewport[3] && bbox[3] >= viewport[1];
  return latitudeIntersects && longitudeIntervalsIntersect(bbox, viewport);
}

export function bboxForFeatures(features: SeriesIndexFeature[]) {
  const entries = features.map(featureBboxEntry).filter((entry): entry is BboxEntry => Boolean(entry));
  const usableEntries = entries.some((entry) => !isWorldSpanningBbox(entry.bbox))
    ? entries.filter((entry) => !isWorldSpanningBbox(entry.bbox))
    : entries;
  const bbox = emptyBbox();
  const longitudes: number[] = [];

  for (const entry of usableEntries) {
    extendBbox(bbox, entry.bbox);
    longitudes.push(...entry.longitudes);
  }

  if (!bbox.valid) return undefined;
  const [minX, maxX] = wrappedLongitudeRange(longitudes, bbox.minX, bbox.maxX);
  return [minX, bbox.minY, maxX, bbox.maxY] as Bbox;
}

export function asFeatureCollection(features: SeriesIndexFeature[]): SeriesIndex {
  return {
    type: "FeatureCollection",
    features,
    bbox: bboxForFeatures(features),
  };
}

export function compareScaleLabels(left: string, right: string) {
  return scaleNumber(left) - scaleNumber(right) || left.localeCompare(right, "en", { numeric: true });
}

type BboxEntry = {
  bbox: Bbox;
  longitudes: number[];
};

function featureBboxEntry(feature: SeriesIndexFeature) {
  const bbox = emptyBbox();
  const longitudes: number[] = [];

  if (Array.isArray(feature.bbox) && feature.bbox.length >= 4) {
    extendBbox(bbox, feature.bbox as Bbox);
    longitudes.push(Number(feature.bbox[0]), Number(feature.bbox[2]));
  } else if (feature.geometry) {
    extendBboxFromGeometry(bbox, feature.geometry, longitudes);
  }

  if (!bbox.valid) return undefined;
  return {
    bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] as Bbox,
    longitudes,
  };
}

function isWorldSpanningBbox(bbox: Bbox) {
  return bbox[0] <= -179.999 && bbox[2] >= 179.999 && bbox[2] - bbox[0] >= 359.9;
}

function scaleNumber(label: string) {
  const match = label.match(/1:([0-9,]+)/);
  return match ? Number(match[1].replace(/,/g, "")) : Number.MAX_SAFE_INTEGER;
}

function extendBboxFromGeometry(
  target: ReturnType<typeof emptyBbox>,
  geometry?: Geometry | null,
  longitudes: number[] = [],
) {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) extendBboxFromGeometry(target, child, longitudes);
    return;
  }
  extendBboxFromCoordinates(target, geometry.coordinates, longitudes);
}

function extendBboxFromCoordinates(
  target: ReturnType<typeof emptyBbox>,
  coordinates: unknown,
  longitudes: number[] = [],
) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    const longitude = coordinates[0];
    const latitude = coordinates[1];
    extendBbox(target, [longitude, latitude, longitude, latitude]);
    longitudes.push(longitude);
    return;
  }
  for (const child of coordinates) extendBboxFromCoordinates(target, child, longitudes);
}

function longitudeIntervalsIntersect(left: Bbox, right: Bbox) {
  return longitudeIntervals(left).some(([leftMin, leftMax]) =>
    longitudeIntervals(right).some(([rightMin, rightMax]) => leftMin <= rightMax && leftMax >= rightMin),
  );
}

function longitudeIntervals(bbox: Bbox) {
  let [min, , max] = bbox;
  if (max < min) max += 360;
  if (max - min >= 360) return [[0, 360]] as Array<[number, number]>;

  const start = normalizeLongitude360(min);
  const end = normalizeLongitude360(max);
  if (start <= end) return [[start, end]] as Array<[number, number]>;
  return [
    [start, 360],
    [0, end],
  ] as Array<[number, number]>;
}

function wrappedLongitudeRange(longitudes: number[], fallbackMin: number, fallbackMax: number) {
  const normalized = [...new Set(longitudes.map(normalizeLongitude360).filter(Number.isFinite))].sort(
    (left, right) => left - right,
  );

  if (normalized.length < 2) return [fallbackMin, fallbackMax] as const;

  let largestGap = -1;
  let gapIndex = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length] + (index === normalized.length - 1 ? 360 : 0);
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }

  let min = normalized[(gapIndex + 1) % normalized.length];
  let max = normalized[gapIndex];
  if (max < min) max += 360;

  if (max - min >= 359.999) return [fallbackMin, fallbackMax] as const;
  if (min >= 180 && max >= 180) {
    min -= 360;
    max -= 360;
  }
  return [min, max] as const;
}

function normalizeLongitude360(value: number) {
  const normalized = ((Number(value) % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function extendBbox(target: ReturnType<typeof emptyBbox>, bbox: Bbox | number[]) {
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

import type { Geometry } from "geojson";
import type { SeriesIndex, SeriesIndexFeature, SeriesIndexProperties } from "./types.ts";

export type Bbox = [number, number, number, number];

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

export function featureContainsBbox(feature: SeriesIndexFeature, viewport: Bbox, margin = 0) {
  const bbox = featureBbox(feature);
  if (!bbox) return false;
  const marginX = Math.max(0, viewport[2] - viewport[0]) * Math.max(0, margin);
  const marginY = Math.max(0, viewport[3] - viewport[1]) * Math.max(0, margin);
  const expandedViewport: Bbox = [viewport[0] - marginX, viewport[1] - marginY, viewport[2] + marginX, viewport[3] + marginY];
  if (bbox[1] > expandedViewport[1] || bbox[3] < expandedViewport[3]) return false;
  const outerIntervals = longitudeIntervals(bbox);
  return longitudeIntervals(expandedViewport).every(([innerMin, innerMax]) =>
    outerIntervals.some(([outerMin, outerMax]) => outerMin <= innerMin && outerMax >= innerMax),
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

// Rank footprints against the current viewport without relying on collection-
// specific map-scale metadata. Shift longitude bounds to the visible world copy.
export function viewportScore(feature: SeriesIndexFeature, viewport: Bbox): number {
  const bbox = featureBbox(feature);
  if (!bbox) return 0;
  const width = Math.max(0.00001, viewport[2] - viewport[0]);
  const height = Math.max(0.00001, viewport[3] - viewport[1]);
  let best = 0;
  const shift = Math.round(((viewport[0] + viewport[2]) - (bbox[0] + bbox[2])) / 720) * 360;
  for (const offset of [shift - 360, shift, shift + 360]) {
    const w = bbox[0] + offset;
    const e = (bbox[2] < bbox[0] ? bbox[2] + 360 : bbox[2]) + offset;
    const intersection = Math.max(0, Math.min(e, viewport[2]) - Math.max(w, viewport[0])) *
      Math.max(0, Math.min(bbox[3], viewport[3]) - Math.max(bbox[1], viewport[1]));
    const area = Math.max(0.00000001, (e - w) * (bbox[3] - bbox[1]));
    best = Math.max(best, (intersection / area) ** 2 * intersection / (width * height));
    // Points and very narrow geometries remain discoverable.
    if (!intersection && featureIntersectsBbox(feature, viewport) && area < 0.000001) best = Math.max(best, 0.00000001);
  }
  return best;
}

export function rankForViewport(features: SeriesIndexFeature[], viewport: Bbox | null, containmentMargin = 0) {
  if (!viewport) return features;
  return features
    .filter(feature => featureIntersectsBbox(feature, viewport) && !featureContainsBbox(feature, viewport, containmentMargin))
    .map(feature => ({ feature, score: viewportScore(feature, viewport) }))
    .sort((a, b) => b.score - a.score || String(featureId(a.feature)).localeCompare(String(featureId(b.feature))))
    .map(entry => entry.feature);
}

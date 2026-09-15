const topLevelIiifFields = new Set(["dct_title_s", "dct_description_sm"]);
const excludedMetadataFields = new Set([
  "dct_language_sm",
  "dct_format_s",
  "locn_geometry",
  "dcat_bbox",
  "dct_accessRights_s",
  "dct_references_s",
]);

const fieldOrder = [
  "id",
  "dct_title_s",
  "dct_alternative_sm",
  "dct_description_sm",
  "dct_language_sm",
  "dct_creator_sm",
  "dct_publisher_sm",
  "dct_issued_s",
  "dct_subject_sm",
  "dct_spatial_sm",
  "dcat_theme_sm",
  "dct_temporal_sm",
  "gbl_dateRange_drsim",
  "gbl_indexYear_im",
  "schema_provider_s",
  "dct_identifier_sm",
  "gbl_georeferenced_b",
  "gbl_resourceClass_sm",
  "gbl_resourceType_sm",
  "pcdm_memberOf_sm",
  "dct_rights_sm",
  "dct_rightsHolder_sm",
  "gbl_mdModified_dt",
  "gbl_mdVersion_s",
];

const fieldLabels = new Map([
  ["id", "EarthWorks ID"],
  ["dct_title_s", "Title"],
  ["dct_alternative_sm", "Alternative title"],
  ["dct_description_sm", "Description"],
  ["dct_language_sm", "Language"],
  ["dct_creator_sm", "Creator"],
  ["dct_publisher_sm", "Publisher"],
  ["dct_issued_s", "Issued"],
  ["dct_subject_sm", "Subject"],
  ["dct_spatial_sm", "Place"],
  ["dcat_theme_sm", "Theme"],
  ["dct_temporal_sm", "Temporal coverage"],
  ["gbl_dateRange_drsim", "Date range"],
  ["gbl_indexYear_im", "Index years"],
  ["schema_provider_s", "Provider"],
  ["dct_identifier_sm", "Identifier"],
  ["gbl_georeferenced_b", "Georeferenced"],
  ["gbl_resourceClass_sm", "Resource class"],
  ["gbl_resourceType_sm", "Resource type"],
  ["pcdm_memberOf_sm", "Member of"],
  ["dct_rights_sm", "Rights"],
  ["dct_rightsHolder_sm", "Rights holder"],
  ["gbl_mdModified_dt", "Metadata modified"],
  ["gbl_mdVersion_s", "Metadata version"],
]);

const assetReferenceLabels = new Map([
  ["https://openindexmaps.org", "Source index GeoJSON"],
  ["http://www.isotc211.org/schemas/2005/gmd", "ISO 19139 metadata"],
  ["http://www.isotc211.org/schemas/2005/gco", "ISO 19110 metadata"],
  ["http://www.opengis.net/cat/csw/csdgm", "FGDC metadata"],
  ["https://github.com/protomaps/PMTiles", "PMTiles"],
  ["https://flatgeobuf.org/", "FlatGeobuf"],
  ["http://schema.org/downloadUrl", "Zipped source object"],
]);

const assetReferenceFormats = new Map([
  ["https://openindexmaps.org", "application/geo+json"],
  ["http://www.isotc211.org/schemas/2005/gmd", "application/xml"],
  ["http://www.isotc211.org/schemas/2005/gco", "application/xml"],
  ["http://www.opengis.net/cat/csw/csdgm", "application/xml"],
  ["https://github.com/protomaps/PMTiles", "application/vnd.pmtiles"],
  ["https://flatgeobuf.org/", "application/octet-stream"],
  ["http://schema.org/downloadUrl", "application/zip"],
]);

export function metadataPairsFromRecord(
  record,
  { includeTopLevelFields = false, collectionLabels = new Map() } = {},
) {
  if (!record || typeof record !== "object") return [];

  return Object.keys(record)
    .filter((key) => includeTopLevelFields || !topLevelIiifFields.has(key))
    .filter((key) => !excludedMetadataFields.has(key))
    .sort(compareFields)
    .flatMap((key) => {
      const values = metadataValuesForField(key, record[key], { collectionLabels });
      if (values.length === 0) return [];
      return [metadataPair(fieldLabels.get(key) || humanizeField(key), values)];
    });
}

export function summaryTextFromRecord(record) {
  return array(record?.dct_description_sm).find((value) => String(value || "").trim()) || "";
}

export function assetLinksFromRecord(record) {
  const references = parseReferences(record?.dct_references_s);
  const resources = Object.entries(references).flatMap(([key, reference]) =>
    assetResourcesForReference(key, reference, record),
  );
  return dedupeResources(resources);
}

export function temporalYearsFromRecord(record) {
  const years = new Set();

  for (const year of array(record?.gbl_indexYear_im)) addYear(years, year);
  for (const value of array(record?.dct_temporal_sm)) addYearsFromText(years, value);
  for (const value of array(record?.gbl_dateRange_drsim)) addYearsFromText(years, value);

  return [...years].sort((left, right) => left - right);
}

export function decadesFromRecord(record) {
  const decades = temporalYearsFromRecord(record).map((year) => Math.floor(year / 10) * 10);
  const labels = [...new Set(decades)].map((decade) => decade + "s");
  return labels.length ? labels : ["Unknown decade"];
}

export function navDateFromRecord(record) {
  const years = temporalYearsFromRecord(record);
  const year = years[years.length - 1];
  return Number.isFinite(year) ? String(year).padStart(4, "0") + "-01-01T00:00:00Z" : undefined;
}

export function metadataPair(label, value) {
  return {
    label: languageMap(label),
    value: languageMap(value),
  };
}

export function languageMap(value) {
  const values = stringValues(value);
  return { none: values.length ? values : [""] };
}

function compareFields(left, right) {
  const leftIndex = fieldOrder.indexOf(left);
  const rightIndex = fieldOrder.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }
  return left.localeCompare(right, "en");
}

function metadataValuesForField(key, value, options) {
  if (key === "pcdm_memberOf_sm") return memberOfValues(value, options.collectionLabels);
  return stringValues(value);
}

function memberOfValues(value, collectionLabels) {
  return array(value)
    .map((item) => formatCollectionMembership(item, collectionLabels))
    .filter(Boolean);
}

function formatCollectionMembership(value, collectionLabels) {
  const id = normalizeStanfordId(value);
  if (!id) return "";
  const label = collectionLabel(collectionLabels, id);
  return label ? label + " (" + id + ")" : id;
}

function collectionLabel(collectionLabels, id) {
  const bare = normalizeBareDruid(id);
  if (collectionLabels instanceof Map) {
    return collectionLabels.get(id) || collectionLabels.get(bare) || "";
  }
  return collectionLabels?.[id] || collectionLabels?.[bare] || "";
}

function assetResourcesForReference(key, reference, record) {
  if (!assetReferenceLabels.has(key)) return [];
  if (Array.isArray(reference)) {
    return reference.flatMap((item) => assetResourcesForReference(key, item, record));
  }

  const id = reference && typeof reference === "object"
    ? stringValue(reference.url || reference.id || reference.href || reference.value)
    : stringValue(reference);
  if (!id) return [];

  const label = assetLabel(key, record);
  return [
    compactObject({
      id,
      type: "Dataset",
      label: languageMap(label),
      format: assetReferenceFormats.get(key),
    }),
  ];
}

function assetLabel(key, record) {
  if (key === "http://schema.org/downloadUrl" && /shapefile/i.test(stringValue(record?.dct_format_s))) {
    return "Source shapefile ZIP";
  }
  return assetReferenceLabels.get(key) || key;
}

function parseReferences(value) {
  if (!value) return {};
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function addYearsFromText(years, value) {
  const text = String(value || "");
  const range = text.match(/(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})\D+(?:TO|to|-|–|—|\/)\D*(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 500) {
      for (let year = start; year <= end; year += 1) years.add(year);
      return;
    }
  }

  for (const match of text.matchAll(/\b(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})\b/g)) {
    addYear(years, match[1]);
  }
}

function addYear(years, value) {
  const year = Number(value);
  if (Number.isInteger(year) && year >= 1000 && year <= 2199) years.add(year);
}

function dedupeResources(resources) {
  const seen = new Set();
  return resources.filter((resource) => {
    if (!resource?.id || seen.has(resource.id)) return false;
    seen.add(resource.id);
    return true;
  });
}

function stringValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item)).filter(Boolean);
  const text = stringValue(value);
  return text ? [text] : [];
}

function stringValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return stringValues(value).join("; ");
  return JSON.stringify(value);
}

function humanizeField(key) {
  return String(key)
    .replace(/_(?:s|sm|im|b|dt|drsim)$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeStanfordId(value) {
  const bare = normalizeBareDruid(value);
  return bare ? "stanford-" + bare : "";
}

function normalizeBareDruid(value) {
  return String(value || "")
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

function array(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

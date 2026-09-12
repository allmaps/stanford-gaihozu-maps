import type { Feature, FeatureCollection, Geometry } from "geojson";

export type LanguageMap = Record<string, string[]>;

export type IiifMetadata = {
  label?: LanguageMap;
  value?: LanguageMap;
};

export type LinkResource = {
  id: string;
  type?: string;
  label?: LanguageMap;
  format?: string;
};

export type IiifImage = {
  id?: string;
  type?: string;
  format?: string;
  service?: Array<{ id?: string; "@id"?: string }>;
};

export type IiifResource = {
  id: string;
  type: string;
  label?: LanguageMap;
  summary?: LanguageMap;
  metadata?: IiifMetadata[];
  thumbnail?: IiifImage[];
  homepage?: LinkResource[];
  seeAlso?: LinkResource[];
  items?: IiifResource[];
};

export type IiifCanvas = {
  id: string;
  type?: string;
  label?: LanguageMap;
  metadata?: IiifMetadata[];
  partOf?: IiifResource[];
  navPlace?: FeatureCollection;
  items?: Array<{
    items?: Array<{
      body?: IiifImage | IiifImage[];
    }>;
  }>;
};

export type IiifManifest = Omit<IiifResource, "items"> & {
  items?: IiifCanvas[];
  navPlace?: FeatureCollection;
};

export type SeriesIndexProperties = {
  id?: string;
  seriesDruid?: string;
  manifestId?: string;
  label?: string;
  regions?: string[];
  scales?: string[];
  sheetCount?: number;
  sourceFeatureCount?: number;
  thumbnailId?: string;
  _scaleDenominator?: number;
};

export type SeriesIndexFeature = Feature<Geometry, SeriesIndexProperties>;

export type SeriesIndex = FeatureCollection<Geometry, SeriesIndexProperties> & {
  bbox?: [number, number, number, number];
  name?: string;
};

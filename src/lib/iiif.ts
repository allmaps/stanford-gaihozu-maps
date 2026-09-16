import { assets, base } from "$app/paths";
import config from '../../site.config.json';
import type { IiifCanvas, IiifImage, IiifManifest, IiifResource, LanguageMap } from "./types";

const staticBasePath = normalizeBasePath(assets || base || "/");

export function publicPath(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : "/" + path;
  const withoutExistingBase = stripBasePath(normalizedPath);
  return staticBasePath === "/" ? withoutExistingBase : staticBasePath.replace(/\/$/, "") + withoutExistingBase;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(url + " returned " + String(response.status));
  }
  return response.json() as Promise<T>;
}

export async function fetchCollection(url = publicPath("/iiif/collection.json")) {
  return fetchJson<IiifResource>(url);
}

export async function fetchManifest(ref: IiifResource) {
  return fetchJson<IiifManifest>(localPath(ref.id));
}

export function label(map?: LanguageMap | string) {
  if (!map) return "";
  if (typeof map === "string") return map;
  return map.en?.[0] || map.none?.[0] || Object.values(map)[0]?.[0] || "";
}

export function localPath(url: string) {
  const canonical = config.canonicalDataBaseUrl.replace(/\/$/, '');
  if (canonical && url.startsWith(canonical + '/')) return publicPath(url.slice(canonical.length));
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return publicPath(localAssetPath(new URL(url).pathname));
  } catch {
    return publicPath(localAssetPath(url));
  }
}

function localAssetPath(path: string) {
  const match = path.match(new RegExp("/(?:iiif|geojson)/"));
  return match?.index === undefined ? path : path.slice(match.index);
}

function normalizeBasePath(path: string) {
  if (!path || path === "/") return "/";
  return path.startsWith("/") ? path.replace(/\/?$/, "/") : "/" + path.replace(/\/?$/, "/");
}

function stripBasePath(path: string) {
  if (staticBasePath === "/" || !path.startsWith(staticBasePath)) return path;
  return "/" + path.slice(staticBasePath.length).replace(/^\//, "");
}

export function countManifests(items: IiifResource[]) {
  const ids = new Set<string>();
  const visit = (item: IiifResource) => {
    if (item.type === "Manifest") ids.add(item.id);
    for (const child of item.items || []) visit(child);
  };
  for (const item of items) visit(item);
  return ids.size;
}

export function firstManifest(items: IiifResource[]): IiifResource | undefined {
  for (const item of items) {
    if (item.type === "Manifest") return item;
    const child = firstManifest(item.items || []);
    if (child) return child;
  }
  return undefined;
}

export function canvasImage(canvas: IiifCanvas) {
  const body = canvas.items?.[0]?.items?.[0]?.body;
  const image = Array.isArray(body) ? body[0] : body;
  return imageUrl(image);
}

export function imageUrl(image?: IiifImage) {
  const service = image?.service?.[0];
  const serviceId = service?.id || service?.["@id"];
  if (serviceId) {
    const normalizedServiceId = serviceId.endsWith("/") ? serviceId.slice(0, -1) : serviceId;
    return normalizedServiceId + "/full/400,/0/default.jpg";
  }
  return image?.id || "";
}

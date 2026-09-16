import type { IiifResource, SeriesIndexFeature } from './types.ts';

export function languageText(value?: Record<string, string[]> | string): string {
  if (typeof value === 'string') return value;
  return value?.en?.join(' ') || value?.none?.join(' ') || Object.values(value || {}).flat().join(' ');
}

export type Facet = { id: string; label: string; options: { id: string; label: string; members: Set<string> }[] };
export type Catalog = { root: IiifResource; manifests: IiifResource[]; facets: Facet[] };

export async function loadCatalog(rootUrl: string, read: (url: string) => Promise<IiifResource>): Promise<Catalog> {
  const root = await read(rootUrl);
  if (root.type !== 'Collection') throw new Error('The configured IIIF resource must be a Presentation 3 Collection.');
  const collections = new Map<string, IiifResource>();
  const manifests = new Map<string, IiifResource>();
  let queue = [root];
  const requested = new Set<string>();
  while (queue.length) {
    const batch = queue.splice(0, 6).filter(ref => {
      if (requested.has(ref.id)) return false;
      requested.add(ref.id);
      return true;
    });
    const loaded = await Promise.all(batch.map(ref => ref.items ? ref : read(ref.id)));
    for (const collection of loaded) {
      if (collection.type !== 'Collection') throw new Error(`Expected a collection at ${collection.id}`);
      collections.set(collection.id, collection);
      for (const child of collection.items || []) {
        if (child.type === 'Collection') queue.push(child);
        else if (child.type === 'Manifest') {
          const previous = manifests.get(child.id);
          manifests.set(child.id, { ...previous, ...child,
            navPlace: child.navPlace ?? previous?.navPlace, navDate: child.navDate ?? previous?.navDate,
            thumbnail: child.thumbnail ?? previous?.thumbnail, summary: child.summary ?? previous?.summary });
        }
      }
    }
  }
  // Standard IIIF collections may only have bare references. Fetch those with
  // bounded concurrency; this project's rich references avoid large manifest loads.
  const incomplete = [...manifests.values()].filter(ref => !ref.navPlace);
  for (let i = 0; i < incomplete.length; i += 6) {
    await Promise.all(incomplete.slice(i, i + 6).map(async ref => {
      const full = await read(ref.id);
      if (full.type !== 'Manifest') throw new Error(`Expected a manifest at ${ref.id}`);
      manifests.set(ref.id, full);
    }));
  }
  function members(id: string, visiting = new Set<string>()): Set<string> {
    if (manifests.has(id)) return new Set([id]);
    if (visiting.has(id)) return new Set();
    const next = new Set(visiting).add(id);
    return new Set((collections.get(id)?.items || []).flatMap(child => [...members(child.id, next)]));
  }
  const facets: Facet[] = [];
  const roots = (root.items || []).filter(ref => ref.type === 'Collection');
  // Each top-level grouping becomes a facet. Nested collections are options,
  // with membership inherited recursively. A flat root gets one collection facet.
  for (const ref of roots) {
    const collection = collections.get(ref.id)!;
    const options = (collection.items || []).filter(child => child.type === 'Collection');
    if (options.length) facets.push({ id: ref.id, label: languageText(collection.label),
      options: options.map(option => ({ id: option.id, label: languageText(option.label), members: members(option.id) })) });
  }
  if (!facets.length && roots.length > 1) facets.push({ id: root.id, label: languageText(root.label),
    options: roots.map(ref => ({ id: ref.id, label: languageText(ref.label), members: members(ref.id) })) });
  return { root, manifests: [...manifests.values()], facets };
}

export function navYear(resource: { navDate?: string }): number | null {
  if (!resource.navDate) return null;
  const date = new Date(resource.navDate);
  return Number.isFinite(date.valueOf()) ? date.getUTCFullYear() : null;
}

export function matchesDate(resource: { navDate?: string }, range: number[], includeUndated: boolean) {
  const year = navYear(resource);
  return year === null ? includeUndated : year >= range[0] && year <= range[1];
}

export function manifestFeature(manifest: IiifResource): SeriesIndexFeature {
  const geometries = (manifest.navPlace?.features || []).map(feature => feature.geometry).filter(Boolean);
  return { type: 'Feature', id: manifest.id,
    properties: { id: manifest.id, manifestId: manifest.id, label: languageText(manifest.label),
      summary: languageText(manifest.summary), navDate: manifest.navDate, thumbnailId: manifest.thumbnail?.[0]?.id },
    geometry: geometries.length === 1 ? geometries[0] : { type: 'GeometryCollection', geometries } };
}

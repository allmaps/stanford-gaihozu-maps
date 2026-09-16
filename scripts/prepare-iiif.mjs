import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function firstImageThumbnail(manifest) {
  for (const page of manifest.items?.[0]?.items || []) {
    for (const annotation of page.items || []) {
      if (annotation.motivation !== 'painting') continue;
      const bodies = Array.isArray(annotation.body) ? annotation.body : [annotation.body];
      const image = bodies.find(body => body?.type === 'Image');
      if (!image) continue;
      const service = image.service?.[0];
      const serviceId = service?.id || service?.['@id'];
      return [{ id: serviceId ? `${serviceId.replace(/\/$/, '')}/full/!400,400/0/default.jpg` : image.id,
        type: 'Image', format: image.format || 'image/jpeg' }];
    }
  }
  return manifest.thumbnail;
}

// Compact an existing IIIF graph without changing its public identifiers.
// Publish each manifest's discovery fields once; other memberships are references.
export async function prepareIiif(staticDir = 'static') {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.json')) files.push(file);
    }
  }
  await walk(path.join(staticDir, 'iiif'));
  const resources = new Map();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const resource = JSON.parse(text);
    if (['Collection', 'Manifest'].includes(resource.type)) resources.set(resource.id, { file, text, resource });
  }
  const cleanMetadata = resource => {
    if (resource.metadata) resource.metadata = resource.metadata.filter(pair =>
      !Object.values(pair.label || {}).flat().some(value => ['date range', 'index years'].includes(String(value).toLowerCase())));
  };
  for (const { resource } of resources.values()) {
    cleanMetadata(resource);
    if (resource.type === 'Manifest') {
      resource.thumbnail = firstImageThumbnail(resource);
      for (const canvas of resource.items || []) cleanMetadata(canvas);
    }
  }
  const seenCollections = new Set();
  const seenManifests = new Set();
  function compact(collection) {
    if (seenCollections.has(collection.id)) return;
    seenCollections.add(collection.id);
    collection.items = (collection.items || []).map(ref => {
      const target = resources.get(ref.id)?.resource || ref;
      const short = { id: target.id, type: target.type, label: target.label };
      if (target.type === 'Collection') {
        compact(target);
        return short;
      }
      if (seenManifests.has(target.id)) return short;
      seenManifests.add(target.id);
      return { ...short, thumbnail: target.thumbnail, navDate: target.navDate,
        navPlace: target.navPlace, summary: target.summary };
    });
    if (collection.items.some(item => item.navPlace)) collection['@context'] = [
      'http://iiif.io/api/extension/navplace/context.json', 'http://iiif.io/api/presentation/3/context.json'];
  }
  const root = [...resources.values()].find(entry => path.resolve(entry.file) === path.resolve(staticDir, 'iiif/collection.json'));
  if (root) compact(root.resource);
  for (const { resource } of resources.values()) if (resource.type === 'Collection') compact(resource);
  let changed = 0;
  for (const { file, text, resource } of resources.values()) {
    const next = JSON.stringify(resource, null, 2) + '\n';
    if (next !== text) { await writeFile(file, next); changed++; }
  }
  console.log(`Prepared ${resources.size} IIIF resources (${changed} changed).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await prepareIiif(process.argv[2]);

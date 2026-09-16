<script lang="ts">
  import { canvasImage, label, localPath } from '../iiif';
  import { Braces, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, ScrollText } from '@lucide/svelte';
  import type { IiifManifest, IiifResource } from '../types';

  type Props = { manifest: IiifManifest | null; manifestRef: IiifResource | null; loading: boolean; error: string; showTitle?: boolean };
  let { manifest, manifestRef, loading, error, showTitle = true }: Props = $props();
  const pageSize = 24;
  let currentPage = $state(1);
  let previousManifestId = '';
  const canvases = $derived(manifest?.items || []);
  const previewImages = $derived(canvases.map(canvas => ({ canvas, image: canvasImage(canvas) })).filter(item => Boolean(item.image)));
  const totalPages = $derived(Math.max(1, Math.ceil(previewImages.length / pageSize)));
  const pageStart = $derived((currentPage - 1) * pageSize);
  const paginatedPreviewImages = $derived(previewImages.slice(pageStart, pageStart + pageSize));
  const manifestUrl = $derived(manifest?.id || manifestRef?.id || '');
  const theseusUrl = $derived(`https://theseusviewer.org/?iiif-content=${encodeURIComponent(manifestUrl)}`);
  const allmapsUrl = $derived(`https://editor.allmaps.org/images?url=${encodeURIComponent(manifestUrl)}`);
  const metadataEntries = $derived((manifest?.metadata || []).map(item => ({
    label: metadataText(item.label) || 'Metadata', value: metadataText(item.value)
  })).filter(item => item.value));
  const geojsonPath = $derived.by(() => {
    const geojson = manifest?.seeAlso?.find(item =>
      item.format?.toLocaleLowerCase() === 'application/geo+json' || /\.geojson(?:$|[?#])/i.test(item.id));
    return geojson ? localPath(geojson.id) : '';
  });

  $effect(() => {
    const manifestId = manifest?.id || '';
    if (manifestId !== previousManifestId) { previousManifestId = manifestId; currentPage = 1; }
    else if (currentPage > totalPages) currentPage = totalPages;
  });

  function metadataText(map?: Record<string, string[]> | string) {
    if (!map) return '';
    return typeof map === 'string' ? map : Object.values(map).flat().filter(Boolean).join('; ');
  }
</script>

{#if loading}
  <div class="p-8 text-sm text-slate-500 dark:text-slate-400">Loading manifest…</div>
{:else if error}
  <div class="rounded-lg bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</div>
{:else if manifest}
  <header class="text-sm leading-7 text-slate-600 dark:text-slate-300">
    {#if showTitle}<h2 class="text-xl font-semibold text-slate-900 dark:text-white">{label(manifest.label) || label(manifestRef?.label) || manifest.id}</h2>{/if}
    {#if label(manifest.summary)}<p>{label(manifest.summary)}</p>{/if}
    <div class="my-4 flex flex-wrap gap-2">
      <a class="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:border-slate-700 dark:bg-slate-900 dark:text-teal-300 dark:hover:bg-slate-800" href={theseusUrl} target="_blank" rel="noreferrer"><span>Open in Theseus</span><ExternalLink size={14} /></a>
      <a class="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:border-slate-700 dark:bg-slate-900 dark:text-teal-300 dark:hover:bg-slate-800" href={allmapsUrl} target="_blank" rel="noreferrer"><span>Open in Allmaps</span><ExternalLink size={14} /></a>
      <a class="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:border-slate-700 dark:bg-slate-900 dark:text-teal-300 dark:hover:bg-slate-800" href={localPath(manifest.id)}><ScrollText size={16} /><span>Manifest</span><ExternalLink size={14} /></a>
      {#if geojsonPath}<a class="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:border-slate-700 dark:bg-slate-900 dark:text-teal-300 dark:hover:bg-slate-800" href={geojsonPath}><Braces size={16} /><span>GeoJSON</span><ExternalLink size={14} /></a>{/if}
    </div>
  </header>

  {#if metadataEntries.length}
    <details class="group my-5 rounded-xl bg-slate-50 dark:bg-slate-950" aria-label="Manifest metadata">
      <summary class="flex cursor-pointer list-none items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:hover:bg-slate-900">
        <span>Metadata <span class="font-normal text-slate-500 dark:text-slate-400">({metadataEntries.length})</span></span>
        <ChevronDown class="transition-transform duration-200 group-open:rotate-180" size={17} aria-hidden="true" />
      </summary>
      <dl class="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-slate-200 px-4 py-4 text-xs sm:grid-cols-2 lg:grid-cols-3 dark:border-slate-800">
        {#each metadataEntries as entry}<div><dt class="mb-1 font-semibold text-slate-800 dark:text-slate-100">{entry.label}</dt><dd class="m-0 break-words leading-5 text-slate-500 dark:text-slate-400">{entry.value}</dd></div>{/each}
      </dl>
    </details>
  {/if}

  {#if totalPages > 1}
    <nav class="my-5 flex items-center justify-between text-xs" aria-label="Thumbnail pages">
      <button class="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" onclick={() => currentPage = Math.max(1, currentPage - 1)} disabled={currentPage === 1}><ChevronLeft size={16} />Previous</button>
      <span>Page {currentPage} of {totalPages}</span>
      <button class="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" onclick={() => currentPage = Math.min(totalPages, currentPage + 1)} disabled={currentPage === totalPages}>Next<ChevronRight size={16} /></button>
    </nav>
  {/if}

  <section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Manifest thumbnails">
    {#each paginatedPreviewImages as item (item.canvas.id)}
      <figure class="m-0"><img class="h-40 w-full rounded-lg border border-slate-200 bg-stone-100 object-contain dark:border-slate-700 dark:bg-slate-950" src={item.image} alt="" loading="lazy" /><figcaption class="pt-2 text-xs leading-5">{label(item.canvas.label) || item.canvas.id}</figcaption></figure>
    {/each}
  </section>
{:else}
  <div class="p-8 text-sm text-slate-500">Build data with <code>pnpm run build:sample</code>.</div>
{/if}

<script lang="ts">
  import { canvasImage, label, localPath } from "../iiif";
  import { Braces, ChevronLeft, ChevronRight, ExternalLink, ScrollText } from "@lucide/svelte";
  import type { IiifManifest, IiifResource } from "../types";

  type Props = {
    manifest: IiifManifest | null;
    manifestRef: IiifResource | null;
    loading: boolean;
    error: string;
    showTitle?: boolean;
  };

  let { manifest, manifestRef, loading, error, showTitle = true }: Props = $props();

  const pageSize = 24;
  let currentPage = $state<number>(1);
  let previousManifestId = "";

  let canvases = $derived(manifest?.items || []);
  let previewImages = $derived(
    canvases
      .map((canvas) => ({ canvas, image: canvasImage(canvas) }))
      .filter((item) => Boolean(item.image)),
  );
  let totalPages = $derived(Math.max(1, Math.ceil(previewImages.length / pageSize)));
  let pageStart = $derived((currentPage - 1) * pageSize);
  let paginatedPreviewImages = $derived(previewImages.slice(pageStart, pageStart + pageSize));
  let pageLabel = $derived("Page " + currentPage + " of " + totalPages);
  let metadataEntries = $derived(
    (manifest?.metadata || [])
      .map((item) => ({
        label: metadataText(item.label) || "Metadata",
        value: metadataText(item.value),
      }))
      .filter((item) => item.value),
  );

  let geojsonPath = $derived.by(() => {
    const geojson = manifest?.seeAlso?.find((item) => item.id.endsWith(".geojson"));
    return geojson ? localPath(geojson.id) : "";
  });

  $effect(() => {
    const manifestId = manifest?.id || "";
    if (manifestId !== previousManifestId) {
      previousManifestId = manifestId;
      currentPage = 1;
    } else if (currentPage > totalPages) {
      currentPage = totalPages;
    }
  });

  function previousPage() {
    currentPage = Math.max(1, currentPage - 1);
  }

  function nextPage() {
    currentPage = Math.min(totalPages, currentPage + 1);
  }

  function metadataText(map?: Record<string, string[]> | string) {
    if (!map) return "";
    if (typeof map === "string") return map;
    return Object.values(map).flat().filter(Boolean).join("; ");
  }
</script>

{#if loading}
  <div class="empty-state">Loading manifest...</div>
{:else if error}
  <div class="empty-state">{error}</div>
{:else if manifest}
  <header class="manifest-header">
    <div>
      {#if showTitle}
        <h2>{label(manifest.label) || label(manifestRef?.label) || manifest.id}</h2>
      {/if}
      {#if label(manifest.summary)}
        <p>{label(manifest.summary)}</p>
      {/if}
    </div>
    <div class="actions">
      <a class="data-link" href={localPath(manifest.id)}><ScrollText size={16} strokeWidth={2.25} aria-hidden="true" /><span>manifest</span><ExternalLink size={14} strokeWidth={2.25} aria-hidden="true" /></a>
      {#if geojsonPath}
        <a class="data-link" href={geojsonPath}><Braces size={16} strokeWidth={2.25} aria-hidden="true" /><span>geojson</span><ExternalLink size={14} strokeWidth={2.25} aria-hidden="true" /></a>
      {/if}
    </div>
  </header>

  <dl class="stats">
    <div>
      <dt>Canvases</dt>
      <dd>{canvases.length}</dd>
    </div>
  </dl>

  {#if metadataEntries.length}
    <section class="manifest-metadata" aria-label="Manifest metadata">
      <h3>Metadata</h3>
      <dl>
        {#each metadataEntries as entry}
          <div>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}

  {#if totalPages > 1}
    <nav class="pagination-bar" aria-label="Thumbnail pages">
      <button class="pagination-button" type="button" onclick={previousPage} disabled={currentPage === 1}>
        <ChevronLeft size={16} strokeWidth={2.25} aria-hidden="true" />
        Previous
      </button>
      <span>{pageLabel}</span>
      <button class="pagination-button" type="button" onclick={nextPage} disabled={currentPage === totalPages}>
        Next
        <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </nav>
  {/if}

  <section class="thumb-grid" aria-label="Manifest thumbnails">
    {#each paginatedPreviewImages as item (item.canvas.id)}
      <figure>
        <img src={item.image} alt="" loading="lazy" />
        <figcaption>{label(item.canvas.label) || item.canvas.id}</figcaption>
      </figure>
    {/each}
  </section>
{:else}
  <div class="empty-state">Build data with <code>pnpm run build:sample</code>.</div>
{/if}

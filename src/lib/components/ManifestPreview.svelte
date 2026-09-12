<script lang="ts">
  import { canvasImage, label, localPath } from "../iiif";
  import { Braces, ExternalLink, ScrollText } from "@lucide/svelte";
  import type { IiifManifest, IiifResource } from "../types";

  type Props = {
    manifest: IiifManifest | null;
    manifestRef: IiifResource | null;
    loading: boolean;
    error: string;
    showTitle?: boolean;
  };

  let { manifest, manifestRef, loading, error, showTitle = true }: Props = $props();

  let canvases = $derived(manifest?.items || []);
  let previewImages = $derived(
    canvases
      .map((canvas) => ({ canvas, image: canvasImage(canvas) }))
      .filter((item) => Boolean(item.image))
      .slice(0, 24),
  );
  let geojsonPath = $derived.by(() => {
    const geojson = manifest?.seeAlso?.find((item) => item.id.endsWith(".geojson"));
    return geojson ? localPath(geojson.id) : "";
  });
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
    <div>
      <dt>Images Shown</dt>
      <dd>{previewImages.length}</dd>
    </div>
  </dl>

  <section class="thumb-grid" aria-label="Manifest thumbnails">
    {#each previewImages as item (item.canvas.id)}
      <figure>
        <img src={item.image} alt="" loading="lazy" />
        <figcaption>{label(item.canvas.label) || item.canvas.id}</figcaption>
      </figure>
    {/each}
  </section>
{:else}
  <div class="empty-state">Build data with <code>pnpm run build:sample</code>.</div>
{/if}

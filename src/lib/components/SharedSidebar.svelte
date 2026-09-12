<script lang="ts">
  import { tick } from "svelte";
  import { Button } from "bits-ui";
  import { ExternalLink } from "@lucide/svelte";
  import { featureId, featureLabel, propertyList } from "../map-data";
  import type { SeriesIndexFeature } from "../types";

  type FeatureId = string | number;

  type Props = {
    loading: boolean;
    error: string;
    features: SeriesIndexFeature[];
    listedFeatures: SeriesIndexFeature[];
    filteredCount: number;
    selectedFeatureId?: FeatureId | null;
    boundsActive: boolean;
    onFeatureSelect: (id: FeatureId) => void;
    onFeatureView: (id: FeatureId) => void;
    onFeatureHover: (id: FeatureId | null) => void;
  };

  let {
    loading,
    error,
    features,
    listedFeatures,
    filteredCount,
    selectedFeatureId = null,
    boundsActive,
    onFeatureSelect,
    onFeatureView,
    onFeatureHover,
  }: Props = $props();

  let sidebarEl = $state.raw<HTMLElement | null>(null);

  $effect(() => {
    const id = selectedFeatureId;
    if (!sidebarEl || id === null || id === "") return;
    void tick().then(() => {
      const entry = sidebarEl?.querySelector<HTMLElement>('[data-feature-key="' + String(id) + '"]');
      entry?.scrollIntoView({ block: "nearest" });
    });
  });

  function scaleLabel(feature: SeriesIndexFeature) {
    return propertyList(feature.properties?.scales).join("; ") || "Unknown scale";
  }

  function regionLabel(feature: SeriesIndexFeature) {
    return propertyList(feature.properties?.regions).join("; ") || "Unknown region";
  }

  function sheetCountLabel(feature: SeriesIndexFeature) {
    const count = feature.properties?.sheetCount;
    return typeof count === "number" ? formatNumber(count) + " sheets" : "Unknown sheets";
  }

  function sourceFeatureCountLabel(feature: SeriesIndexFeature) {
    const count = feature.properties?.sourceFeatureCount;
    return typeof count === "number" ? formatNumber(count) + " source footprints" : "Unknown footprints";
  }

  function formatNumber(value: number) {
    return new Intl.NumberFormat("en-US").format(value);
  }
</script>

<aside bind:this={sidebarEl} class="sidebar shared-sidebar list-sidebar" aria-label="Visible map series">
  <header class="map-panel-header">
    <h1>Visible Series</h1>
    <p>
      {listedFeatures.length} in map bounds, {filteredCount} matching filters, {features.length} total
    </p>
    <p class="bounds-note">{boundsActive ? "Filtered by current map view" : "Move the map to filter by view"}</p>
  </header>

  {#if loading}
    <p class="map-message">Loading series...</p>
  {:else if error}
    <p class="map-message">{error}</p>
  {:else}
    <div class="map-results">
      {#if listedFeatures.length === 0}
        <p class="map-message">No matching series in the current map view.</p>
      {:else}
        <div class="map-accordion list-results">
          {#each listedFeatures as feature (featureId(feature))}
            {@const id = featureId(feature)}
            {@const thumbnail = feature.properties?.thumbnailId || ""}
            {@const isSelected = String(selectedFeatureId) === String(id)}
            <article
              class="map-entry"
              class:is-selected={isSelected}
              data-state={isSelected ? "open" : "closed"}
              data-feature-key={String(id)}
              onmouseenter={() => onFeatureHover(id)}
              onmouseleave={() => onFeatureHover(null)}
            >
              <Button.Root class="map-entry-summary with-thumbnail" type="button" aria-expanded={isSelected} onclick={() => onFeatureSelect(id)}>
                {#if thumbnail}
                  <img class="entry-thumbnail" src={thumbnail} alt="" loading="lazy" />
                {:else}
                  <span class="entry-thumbnail is-empty" aria-hidden="true"></span>
                {/if}
                <span class="map-entry-copy">
                  <span class="map-entry-title">{featureLabel(feature)}</span>
                  <span class="map-entry-meta">{scaleLabel(feature)} - {sheetCountLabel(feature)}</span>
                  <span class="map-entry-region">{regionLabel(feature)}</span>
                </span>
              </Button.Root>

              {#if isSelected}
                <div class="map-entry-detail">
                  <dl>
                    <div>
                      <dt>Series DRUID</dt>
                      <dd>{feature.properties?.seriesDruid || id}</dd>
                    </div>
                    <div>
                      <dt>Scale</dt>
                      <dd>{scaleLabel(feature)}</dd>
                    </div>
                    <div>
                      <dt>Region</dt>
                      <dd>{regionLabel(feature)}</dd>
                    </div>
                    <div>
                      <dt>Sheets</dt>
                      <dd>{sheetCountLabel(feature)}; {sourceFeatureCountLabel(feature)}</dd>
                    </div>
                  </dl>
                  <Button.Root class="control-button map-entry-view" type="button" onclick={() => onFeatureView(id)}>
                    <ExternalLink size={15} strokeWidth={2.25} aria-hidden="true" />
                    View more
                  </Button.Root>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</aside>

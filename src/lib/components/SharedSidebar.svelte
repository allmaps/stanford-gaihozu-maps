<script lang="ts">
  import { Button } from "bits-ui";
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
    onFeatureOpen: (id: FeatureId) => void;
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
    onFeatureOpen,
    onFeatureHover,
  }: Props = $props();

  function scaleLabel(feature: SeriesIndexFeature) {
    return propertyList(feature.properties?.scales).join("; ") || "Unknown scale";
  }

  function regionLabel(feature: SeriesIndexFeature) {
    return propertyList(feature.properties?.regions).join("; ") || "Unknown region";
  }

  function sheetCountLabel(feature: SeriesIndexFeature) {
    const count = feature.properties?.sheetCount;
    return typeof count === "number" ? String(count) + " sheets" : "Unknown sheets";
  }
</script>

<aside class="sidebar shared-sidebar list-sidebar" aria-label="Visible map series">
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
            <article
              class="map-entry"
              class:is-selected={String(selectedFeatureId) === String(id)}
              data-feature-key={String(id)}
              onmouseenter={() => onFeatureHover(id)}
              onmouseleave={() => onFeatureHover(null)}
            >
              <Button.Root class="map-entry-summary with-thumbnail" type="button" onclick={() => onFeatureOpen(id)}>
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
            </article>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</aside>

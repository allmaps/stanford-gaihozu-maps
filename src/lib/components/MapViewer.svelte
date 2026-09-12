<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import * as maplibregl from "maplibre-gl";
  import {
    asFeatureCollection,
    bboxForFeatures,
    featureById,
    featureId,
    propertyList,
  } from "../map-data";
  import type { Bbox } from "../map-data";
  import type { SeriesIndexFeature } from "../types";

  type FeatureId = string | number;

  type Props = {
    active?: boolean;
    features: SeriesIndexFeature[];
    selectedFeatureId?: FeatureId | null;
    hoveredFeatureId?: FeatureId | null;
    polygonsVisible?: boolean;
    fitToFeaturesKey?: number;
    fitToSelectedKey?: number;
    onViewportBboxChange?: (bbox: Bbox | null) => void;
    onSelectFeature?: (id: FeatureId) => void;
    onHoverFeature?: (id: FeatureId | null) => void;
  };

  let {
    active = true,
    features,
    selectedFeatureId = null,
    hoveredFeatureId = null,
    polygonsVisible = true,
    fitToFeaturesKey = 0,
    fitToSelectedKey = 0,
    onViewportBboxChange = () => {},
    onSelectFeature = () => {},
    onHoverFeature = () => {},
  }: Props = $props();

  const sourceId = "series-index";
  const fillLayerId = "series-index-fill";
  const lineLayerId = "series-index-line";
  const openFreeMapStyle = "https://tiles.openfreemap.org/styles/liberty";

  let mapEl = $state.raw<HTMLDivElement | null>(null);
  let map = $state.raw<maplibregl.Map | null>(null);
  let loaded = $state<boolean>(false);
  let mapError = $state<string>("");
  let appliedSelectedId = $state<FeatureId | null>(null);
  let appliedHoveredId = $state<FeatureId | null>(null);
  let previousFitToFeaturesKey = 0;
  let previousFitToSelectedKey = 0;

  onMount(() => {
    if (active) initMaplibre();
    return () => {
      map?.remove();
      map = null;
    };
  });

  $effect(() => {
    if (!active) return;
    initMaplibre();
    void tick().then(() => {
      map?.resize();
      updateViewportBbox();
    });
  });

  $effect(() => {
    if (!map || !loaded) return;
    const nextFeatures = features;
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(displayFeatureCollection(nextFeatures));
    untrack(() => {
      applyFeatureState(appliedSelectedId, "selected", false);
      applyFeatureState(appliedHoveredId, "hover", false);
      appliedSelectedId = null;
      appliedHoveredId = null;
      syncSelectedState();
      syncHoveredState();
    });
  });

  $effect(() => {
    if (!map || !loaded) return;
    const visibility = polygonsVisible ? "visible" : "none";
    if (map.getLayer(fillLayerId)) map.setLayoutProperty(fillLayerId, "visibility", visibility);
    if (map.getLayer(lineLayerId)) map.setLayoutProperty(lineLayerId, "visibility", visibility);
  });

  $effect(() => {
    if (!map || !loaded) return;
    syncSelectedState();
  });

  $effect(() => {
    if (!map || !loaded) return;
    syncHoveredState();
  });

  $effect(() => {
    if (!map || !loaded || fitToFeaturesKey === previousFitToFeaturesKey) return;
    previousFitToFeaturesKey = fitToFeaturesKey;
    fitToFeatures(features, true);
  });

  $effect(() => {
    if (!map || !loaded || fitToSelectedKey === previousFitToSelectedKey) return;
    previousFitToSelectedKey = fitToSelectedKey;
    const feature = featureById(features, selectedFeatureId);
    if (feature) fitToFeatures([feature], true);
  });

  function initMaplibre() {
    if (!mapEl || map || mapError) return;

    try {
      map = new maplibregl.Map({
        container: mapEl,
        style: openFreeMapStyle,
        center: [126, 27],
        zoom: 3.15,
        maxPitch: 0,
        dragRotate: false,
        touchPitch: false,
        renderWorldCopies: true,
        attributionControl: false,
      });
    } catch (caught) {
      mapError = caught instanceof Error ? caught.message : String(caught);
      onViewportBboxChange(null);
      return;
    }

    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      if (!map) return;
      map.addSource(sourceId, {
        type: "geojson",
        data: displayFeatureCollection(features),
        promoteId: "id",
      });
      addIndexLayers();
      loaded = true;
      fitToFeatures(features, false);
      updateViewportBbox();
      map.on("moveend", updateViewportBbox);
      map.on("resize", updateViewportBbox);
    });
  }

  function addIndexLayers() {
    if (!map) return;

    map.addLayer({
      id: fillLayerId,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          "#B1040E",
          ["boolean", ["feature-state", "hover"], false],
          "#006F54",
          "#008566",
        ],
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2,
          [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.54,
            ["boolean", ["feature-state", "hover"], false],
            0.42,
            ["interpolate", ["linear"], ["coalesce", ["get", "_scaleDenominator"], 1000000], 5000, 0.3, 25000, 0.26, 250000, 0.2, 1000000, 0.16],
          ],
          6,
          [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.54,
            ["boolean", ["feature-state", "hover"], false],
            0.42,
            ["interpolate", ["linear"], ["coalesce", ["get", "_scaleDenominator"], 1000000], 5000, 0.12, 25000, 0.14, 250000, 0.18, 1000000, 0.16],
          ],
          9,
          [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.54,
            ["boolean", ["feature-state", "hover"], false],
            0.42,
            ["interpolate", ["linear"], ["coalesce", ["get", "_scaleDenominator"], 1000000], 5000, 0.04, 25000, 0.07, 250000, 0.14, 1000000, 0.16],
          ],
        ],
      },
    });

    map.addLayer({
      id: lineLayerId,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          "#B1040E",
          ["boolean", ["feature-state", "hover"], false],
          "#006F54",
          "#006F54",
        ],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2,
          [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            ["boolean", ["feature-state", "hover"], false],
            0.98,
            0.86,
          ],
          9,
          [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            ["boolean", ["feature-state", "hover"], false],
            0.98,
            ["interpolate", ["linear"], ["coalesce", ["get", "_scaleDenominator"], 1000000], 5000, 0.22, 25000, 0.34, 250000, 0.66, 1000000, 0.76],
          ],
        ],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1,
          ["case", ["boolean", ["feature-state", "selected"], false], 2.6, 1.1],
          5,
          ["case", ["boolean", ["feature-state", "selected"], false], 4.2, 2.2],
        ],
      },
    });

    map.on("mousemove", fillLayerId, (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0] as SeriesIndexFeature | undefined;
      const id = feature ? featureId(feature) : "";
      if (!id) return;
      onHoverFeature(id);
      map?.getCanvas().style.setProperty("cursor", "pointer");
    });

    map.on("mouseleave", fillLayerId, () => {
      onHoverFeature(null);
      map?.getCanvas().style.setProperty("cursor", "");
    });

    map.on("click", fillLayerId, (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0] as SeriesIndexFeature | undefined;
      const id = feature ? featureId(feature) : "";
      if (id) onSelectFeature(id);
    });
  }

  function displayFeatureCollection(nextFeatures: SeriesIndexFeature[]) {
    return asFeatureCollection(nextFeatures.map(withScaleDenominator));
  }

  function withScaleDenominator(feature: SeriesIndexFeature): SeriesIndexFeature {
    return {
      ...feature,
      properties: {
        ...feature.properties,
        _scaleDenominator: primaryScaleDenominator(feature),
      },
    };
  }

  function primaryScaleDenominator(feature: SeriesIndexFeature) {
    const denominators = propertyList(feature.properties?.scales)
      .map(scaleDenominator)
      .filter(Number.isFinite);
    return denominators.length ? Math.min(...denominators) : 1000000;
  }

  function scaleDenominator(label: string) {
    const match = label.match(/1:([0-9,]+)/);
    return match ? Number(match[1].replace(/,/g, "")) : Number.POSITIVE_INFINITY;
  }

  function syncSelectedState() {
    if (String(appliedSelectedId) === String(selectedFeatureId)) return;
    applyFeatureState(appliedSelectedId, "selected", false);
    appliedSelectedId = selectedFeatureId;
    applyFeatureState(appliedSelectedId, "selected", true);
  }

  function syncHoveredState() {
    if (String(appliedHoveredId) === String(hoveredFeatureId)) return;
    applyFeatureState(appliedHoveredId, "hover", false);
    appliedHoveredId = hoveredFeatureId;
    applyFeatureState(appliedHoveredId, "hover", true);
  }

  function applyFeatureState(id: FeatureId | null, key: "hover" | "selected", value: boolean) {
    if (!map || !map.getSource(sourceId) || id === null || id === "") return;
    map.setFeatureState({ source: sourceId, id }, { [key]: value });
  }

  function updateViewportBbox() {
    if (!map) {
      onViewportBboxChange(null);
      return;
    }
    const bounds = map.getBounds();
    onViewportBboxChange([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
  }

  function fitToFeatures(nextFeatures: SeriesIndexFeature[], animate: boolean) {
    if (!map || nextFeatures.length === 0) return;
    const bbox = bboxForFeatures(nextFeatures);
    if (!bbox) return;
    const narrow = window.innerWidth <= 760;
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      {
        padding: narrow
          ? { top: 24, right: 20, bottom: 24, left: 20 }
          : { top: 44, right: 44, bottom: 44, left: 44 },
        duration: animate ? 500 : 0,
      },
    );
  }
</script>

<div bind:this={mapEl} class="map-container" aria-label="Unionized sheet index map">
  {#if mapError}
    <p class="map-message map-error">{mapError}</p>
  {/if}
</div>

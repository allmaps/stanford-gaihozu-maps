<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as maplibre from 'maplibre-gl';
  import config from '../../../site.config.json';
  import { asFeatureCollection, bboxForFeatures, featureBbox, featureId } from '../map-data';
  import type { Bbox } from '../map-data';
  import type { SeriesIndexFeature } from '../types';

  let { features, densityFeatures = features, selectedFeatureId = null, hoveredFeatureId = null,
    polygonsVisible = true, densityEnabled = true, darkMode = false, fitToFeaturesKey = 0,
    onViewportChange = (_bbox: Bbox, _zoom: number) => {},
    onSelectFeature = (_id: string | number) => {}, onHoverFeature = (_id: string | number | null) => {} }:
    { features: SeriesIndexFeature[]; densityFeatures?: SeriesIndexFeature[]; selectedFeatureId?: string | number | null;
      hoveredFeatureId?: string | number | null; polygonsVisible?: boolean; densityEnabled?: boolean; darkMode?: boolean; fitToFeaturesKey?: number;
      onViewportChange?: (bbox: Bbox, zoom: number) => void; onSelectFeature?: (id: string | number) => void;
      onHoverFeature?: (id: string | number | null) => void } = $props();

  let container: HTMLDivElement;
  let map: maplibre.Map | undefined;
  let ready = $state(false);
  let mapError = $state('');
  let lastFit = 0;
  let previousSelected: string | number | null = null;
  let previousHovered: string | number | null = null;
  let currentStyle = '';
  const palette = config.map.palette.colors;
  const footprintOpacity = ['case', ['boolean', ['feature-state', 'selected'], false], 0.42,
    ['boolean', ['feature-state', 'hover'], false], 0.46, 0.08] as maplibre.ExpressionSpecification;
  const densityAreaOpacity = ['interpolate', ['linear'], ['zoom'], 0, 0.075, 2, 0.06, 5, 0] as maplibre.ExpressionSpecification;
  const heatOpacity = ['interpolate', ['linear'], ['zoom'], config.map.densityMinZoom, 0.5, 5, 0.72, 9, 0.8, 12, 0.58] as maplibre.ExpressionSpecification;
  const dotOpacity = ['interpolate', ['linear'], ['zoom'], 0, 0.35, 4, 0.65, 8, 0.82] as maplibre.ExpressionSpecification;

  export function zoomIn() { map?.easeTo({ zoom: map.getZoom() + 1, duration: 280 }); }
  export function zoomOut() { map?.easeTo({ zoom: map.getZoom() - 1, duration: 280 }); }
  export function fitFeature(feature: SeriesIndexFeature) { fit([feature], 13); }

  onMount(() => {
    try {
      const savedTheme = localStorage.getItem('atlas-theme');
      const initiallyDark = savedTheme ? savedTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      currentStyle = initiallyDark ? config.map.darkStyle : config.map.style;
      map = new maplibre.Map({ container, style: currentStyle, hash: true,
        center: config.map.center as [number, number], zoom: config.map.zoom,
        maxPitch: 0, dragRotate: false, attributionControl: false });
      map.touchZoomRotate.disableRotation();
      map.on('style.load', setupLayers);
      map.on('moveend', reportViewport);
      map.on('error', event => {
        console.error('[atlas map]', event.error);
        mapError = event.error?.message || 'A map resource could not be loaded.';
      });
      map.on('mousemove', event => {
        const hit = interactiveFeature(event.point);
        onHoverFeature(hit?.id ?? null);
        if (map) map.getCanvas().style.cursor = hit ? 'pointer' : '';
      });
      map.on('mouseout', () => {
        onHoverFeature(null);
        if (map) map.getCanvas().style.cursor = '';
      });
      map.on('click', event => {
        const id = interactiveFeature(event.point)?.id;
        if (id !== undefined) onSelectFeature(id);
      });
    } catch (error) { mapError = String(error); }
    const observer = new ResizeObserver(() => { map?.resize(); reportViewport(); });
    observer.observe(container);
    return () => { observer.disconnect(); map?.remove(); map = undefined; };
  });

  $effect(() => {
    const nextStyle = darkMode ? config.map.darkStyle : config.map.style;
    const currentMap = map;
    if (currentMap && currentStyle && nextStyle !== currentStyle) untrack(() => {
      const switchStyle = () => {
        if (nextStyle === currentStyle) return;
        currentStyle = nextStyle;
        ready = false;
        currentMap.setStyle(nextStyle, { diff: false });
      };
      if (currentMap.isStyleLoaded()) switchStyle();
      else currentMap.once('style.load', switchStyle);
    });
  });

  $effect(() => {
    const current = features;
    const locations = densityFeatures;
    if (ready) untrack(() => {
      (map?.getSource('footprints') as maplibre.GeoJSONSource)?.setData(asFeatureCollection(current));
      (map?.getSource('density-areas') as maplibre.GeoJSONSource)?.setData(asFeatureCollection(locations));
      (map?.getSource('locations') as maplibre.GeoJSONSource)?.setData(locationData(locations));
    });
  });
  $effect(() => {
    const outlines = polygonsVisible;
    const density = densityEnabled;
    if (ready) untrack(() => updateOpacity(outlines, density));
  });
  $effect(() => {
    const selected = selectedFeatureId;
    const hovered = hoveredFeatureId;
    if (ready) untrack(() => {
      setState(previousSelected, 'selected', false); setState(previousHovered, 'hover', false);
      setState(selected, 'selected', true); setState(hovered, 'hover', true);
      previousSelected = selected; previousHovered = hovered;
    });
  });
  $effect(() => {
    const key = fitToFeaturesKey;
    if (ready && key !== lastFit) untrack(() => { lastFit = key; fit(densityFeatures); });
  });

  function setupLayers() {
    if (!map) return;
    if (map.getSource('footprints')) return;
    map.addSource('footprints', { type: 'geojson', data: asFeatureCollection(features), promoteId: 'id' });
    map.addSource('density-areas', { type: 'geojson', data: asFeatureCollection(densityFeatures), promoteId: 'id' });
    map.addSource('locations', { type: 'geojson', data: locationData(densityFeatures), promoteId: 'id' });
    map.addLayer({ id: 'density-areas', type: 'fill', source: 'density-areas', paint: {
      'fill-color': palette[5], 'fill-opacity': densityAreaOpacity, 'fill-antialias': false,
      'fill-opacity-transition': { duration: 320, delay: 0 } } });
    map.addLayer({ id: 'footprints-fill', type: 'fill', source: 'footprints', paint: {
      'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], palette[8],
        ['boolean', ['feature-state', 'hover'], false], palette[6], palette[4]],
      'fill-opacity': footprintOpacity, 'fill-opacity-transition': { duration: 220, delay: 0 } } });
    map.addLayer({ id: 'locations-heat', type: 'heatmap', source: 'locations', minzoom: config.map.densityMinZoom,
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], config.map.densityMinZoom, 1.25, 9, 1.9],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], config.map.densityMinZoom, 44, 9, 78],
        'heatmap-opacity': heatOpacity, 'heatmap-opacity-transition': { duration: 320, delay: 0 },
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(247,252,253,0)', 0.12, palette[1], 0.25, palette[2], 0.38, palette[3],
          0.5, palette[4], 0.63, palette[5], 0.76, palette[6], 0.89, palette[7], 1, palette[8]]
      } });
    map.addLayer({ id: 'footprints-line', type: 'line', source: 'footprints', paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], palette[8],
        ['boolean', ['feature-state', 'hover'], false], palette[7], palette[6]],
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3.2,
        ['boolean', ['feature-state', 'hover'], false], 3.8, 1.1], 'line-opacity': 0.9,
      'line-opacity-transition': { duration: 220, delay: 0 } } });
    map.addLayer({ id: 'locations-dots', type: 'circle', source: 'locations', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.2, 8, 4.2],
      'circle-color': palette[6], 'circle-opacity': dotOpacity, 'circle-opacity-transition': { duration: 260, delay: 0 },
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2, 'circle-stroke-opacity': dotOpacity,
      'circle-stroke-opacity-transition': { duration: 260, delay: 0 } } });
    ready = true;
    updateOpacity(polygonsVisible, densityEnabled);
    setState(selectedFeatureId, 'selected', true);
    setState(hoveredFeatureId, 'hover', true);
    reportViewport();
  }

  function locationData(items: SeriesIndexFeature[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
    return { type: 'FeatureCollection', features: items.flatMap(feature => {
      const box = featureBbox(feature);
      if (!box) return [];
      let east = box[2]; if (east < box[0]) east += 360;
      return [{ type: 'Feature' as const, id: featureId(feature), properties: { id: featureId(feature) },
        geometry: { type: 'Point' as const, coordinates: [(box[0] + east) / 2, (box[1] + box[3]) / 2] } }];
    }) };
  }
  function setState(id: string | number | null, name: string, value: boolean) {
    if (id !== null) map?.setFeatureState({ source: 'footprints', id }, { [name]: value });
  }
  function updateOpacity(outlines: boolean, density: boolean) {
    if (!map) return;
    map.setPaintProperty('footprints-fill', 'fill-opacity', outlines ? footprintOpacity : 0);
    map.setPaintProperty('footprints-line', 'line-opacity', outlines ? 0.9 : 0);
    map.setPaintProperty('density-areas', 'fill-opacity', density ? densityAreaOpacity : 0);
    map.setPaintProperty('locations-heat', 'heatmap-opacity', density ? heatOpacity : 0);
    map.setPaintProperty('locations-dots', 'circle-opacity', density ? dotOpacity : 0);
    map.setPaintProperty('locations-dots', 'circle-stroke-opacity', density ? dotOpacity : 0);
  }
  function interactiveFeature(point: maplibre.PointLike) {
    if (!map || !ready) return undefined;
    const layers = [densityEnabled && 'locations-dots', polygonsVisible && 'footprints-fill']
      .filter((id): id is string => Boolean(id && map?.getLayer(id)));
    const rendered = map.queryRenderedFeatures(point, { layers });
    const smallest = rendered.sort((left, right) => featureExtentArea(left.id) - featureExtentArea(right.id))[0];
    if (smallest) return smallest;
    if (!densityEnabled) return undefined;
    const screenPoint = maplibre.Point.convert(point);
    let nearest: { id: string | number; distance: number } | undefined;
    for (const feature of densityFeatures) {
      const box = featureBbox(feature);
      if (!box) continue;
      let east = box[2]; if (east < box[0]) east += 360;
      const projected = map.project([(box[0] + east) / 2, (box[1] + box[3]) / 2]);
      const distance = projected.dist(screenPoint);
      if (distance <= 18 && (!nearest || distance < nearest.distance)) nearest = { id: featureId(feature), distance };
    }
    return nearest;
  }
  function featureExtentArea(id: string | number | undefined) {
    const feature = features.find(candidate => String(featureId(candidate)) === String(id));
    const box = feature && featureBbox(feature);
    if (!box) return Number.POSITIVE_INFINITY;
    let east = box[2];
    if (east < box[0]) east += 360;
    return Math.max(0, east - box[0]) * Math.max(0, box[3] - box[1]);
  }
  function reportViewport() {
    if (!map) return;
    const bounds = map.getBounds();
    onViewportChange([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], map.getZoom());
  }
  function fit(items: SeriesIndexFeature[], maxZoom = 12) {
    const bounds = bboxForFeatures(items);
    if (bounds) map?.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      { padding: { top: 70, right: 70, bottom: 190, left: 70 }, maxZoom, duration: 650 });
  }
</script>

<div class="absolute inset-0"><div bind:this={container} class="h-full w-full" aria-label="Collection footprints map"></div></div>
{#if mapError}
  <div class="absolute right-4 top-20 z-20 max-w-xs rounded-xl border border-amber-300 bg-amber-50/90 p-3 text-xs text-amber-950 shadow-lg backdrop-blur-md dark:border-amber-700 dark:bg-amber-950/90 dark:text-amber-100" role="status">
    Some background map resources could not load.
    <button class="float-right rounded p-1" onclick={() => mapError = ''} aria-label="Dismiss map warning">×</button>
    <details class="mt-2 break-words"><summary>Details</summary>{mapError}</details>
  </div>
{/if}

<script lang="ts">
  import { onMount } from "svelte";
  import { Button, Dialog, Popover, Select, Slider, Switch } from "bits-ui";
  import { Braces, Database, ExternalLink, Eye, EyeOff, Funnel, Info, ListTree, Maximize2, RotateCcw, X } from "@lucide/svelte";
  import ManifestPreview from "../lib/components/ManifestPreview.svelte";
  import MapViewer from "../lib/components/MapViewer.svelte";
  import SharedSidebar from "../lib/components/SharedSidebar.svelte";
  import { fetchManifest, publicPath } from "../lib/iiif";
  import {
    featureById,
    featureId,
    featureIntersectsBbox,
    featureLabel,
    fetchSeriesIndex,
    propertyList,
    uniquePropertyValues,
  } from "../lib/map-data";
  import type { Bbox } from "../lib/map-data";
  import type { IiifManifest, IiifResource, SeriesIndex, SeriesIndexFeature } from "../lib/types";

  type FeatureId = string | number;
  type SelectItem = { value: string; label: string };
  type SheetCountBounds = { min: number; max: number; ready: boolean };

  const allRegions = "All regions";
  const allScales = "All scales";
  const collectionPath = publicPath("/iiif/collection.json");
  const seriesIndexPath = publicPath("/iiif/series-index.geojson");
  const earthWorksCollectionUrl = "https://earthworks.stanford.edu/catalog/stanford-ch237ht4777";
  const openGeoMetadataUrl = "https://github.com/OpenGeoMetadata/edu.stanford.purl";
  const iiifNavPlaceUrl = "https://iiif.io/api/extension/navplace/";
  const openFreeMapUrl = "https://openfreemap.org/";
  const mapLibreUrl = "https://maplibre.org/";
  const bitsUiUrl = "https://www.bits-ui.com/";
  const collectionDescription = [
    "Index maps to Japanese military and imperial maps held at Stanford Libraries.",
    "Stanford University Libraries holds a large collection of Japanese military and imperial maps, referred to as gaihozu, or \"maps of outer lands.\"",
    "These maps were produced starting in the early Meiji (1868-1912) era and the end of World War II by the Land Survey Department of the General Staff Headquarters, the former Japanese Army.",
    "The first charge was to map specific territories beyond Japan's borders.",
    "Over time the mapping efforts grew to including \"mapping of interimperial boundaries, cadastral surveys of the colonies, and detailed drawings of strategic cities and fortifications.\"",
    "Geographically the Stanford maps cover a broad area including Japan, China, Mongolia, North Korea, South Korea, the Philippines, and beyond.",
  ].join(" ");
  const appBasePath = normalizeAppBasePath(import.meta.env.BASE_URL || "/");
  const initialManifestId = manifestFromLocation();

  let requestedManifestId = $state<string>(initialManifestId);
  let index = $state.raw<SeriesIndex | null>(null);
  let loadingIndex = $state<boolean>(true);
  let indexError = $state<string>("");
  let selectedFeatureId = $state<FeatureId | null>(null);
  let hoveredFeatureId = $state<FeatureId | null>(null);
  let activeManifestRef = $state<IiifResource | null>(null);
  let activeManifest = $state<IiifManifest | null>(null);
  let loadingManifest = $state<boolean>(false);
  let manifestError = $state<string>("");
  let loadedManifestId = $state<string>("");
  let activeRegion = $state<string>(allRegions);
  let activeScale = $state<string>(allScales);
  let sheetCountRange = $state<number[]>([0, 0]);
  let sheetCountRangeInitialized = false;
  let previousSheetCountMin = 0;
  let previousSheetCountMax = 0;
  let viewportBbox = $state<Bbox | null>(null);
  let polygonsEnabled = $state<boolean>(true);
  let spaceHidingPolygons = $state<boolean>(false);
  let fitToFeaturesKey = $state<number>(0);
  let fitToSelectedKey = $state<number>(0);
  let collectionOpen = $state<boolean>(Boolean(initialManifestId));
  let aboutOpen = $state<boolean>(false);
  let filtersOpen = $state<boolean>(false);
  let sidePanelOpen = $state<boolean>(true);

  let features = $derived<SeriesIndexFeature[]>(index?.features || []);
  let selectedFeature = $derived(featureById(features, selectedFeatureId));
  let regions = $derived(uniquePropertyValues(features, "regions"));
  let regionItems = $derived<SelectItem[]>([
    { value: allRegions, label: allRegions },
    ...regions.map((region) => ({ value: region, label: region })),
  ]);
  let scaleItems = $derived<SelectItem[]>([
    { value: allScales, label: allScales },
    ...uniquePropertyValues(features, "scales").map((scale) => ({ value: scale, label: scale })),
  ]);
  let sheetCountBounds = $derived(sheetBoundsForFeatures(features));
  let sheetCountLabel = $derived(formatSheetCountRange(sheetCountRange, sheetCountBounds));
  let filteredFeatures = $derived(
    features
      .filter((feature) => featureMatchesRegion(feature, activeRegion))
      .filter((feature) => featureMatchesScale(feature, activeScale))
      .filter((feature) => featureMatchesSheetCount(feature))
      .sort((left, right) => featureLabel(left).localeCompare(featureLabel(right), "en", { numeric: true })),
  );
  let listedFeatures = $derived(
    viewportBbox
      ? filteredFeatures.filter((feature) => featureIntersectsBbox(feature, viewportBbox))
      : filteredFeatures,
  );
  let activeFilterCount = $derived(filterCount());
  let polygonsVisible = $derived(polygonsEnabled && !spaceHidingPolygons);
  let polygonVisibilityLabel = $derived(
    polygonsEnabled ? (spaceHidingPolygons ? "Polygons hidden while Space is held" : "Polygons shown") : "Polygons hidden",
  );

  onMount(() => {
    requestedManifestId = manifestFromLocation();
    collectionOpen = Boolean(requestedManifestId);
    void loadIndex();

    const handlePopState = () => {
      requestedManifestId = manifestFromLocation();
      collectionOpen = Boolean(requestedManifestId);
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isFormControl(event.target) || collectionOpen || aboutOpen || filtersOpen) return;
      event.preventDefault();
      spaceHidingPolygons = true;
    };
    const handleKeyup = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceHidingPolygons) return;
      event.preventDefault();
      spaceHidingPolygons = false;
    };
    const handleBlur = () => {
      spaceHidingPolygons = false;
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("keyup", handleKeyup);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
      window.removeEventListener("blur", handleBlur);
    };
  });

  $effect(() => {
    if (!sheetCountBounds.ready) {
      sheetCountRange = [0, 0];
      sheetCountRangeInitialized = false;
      previousSheetCountMin = 0;
      previousSheetCountMax = 0;
      return;
    }

    const { min, max } = sheetCountBounds;
    const wasFullRange = sheetCountRange[0] === previousSheetCountMin && sheetCountRange[1] === previousSheetCountMax;
    const boundsChanged = min !== previousSheetCountMin || max !== previousSheetCountMax;
    const rangeOutOfBounds = sheetCountRange[0] < min || sheetCountRange[1] > max;
    if (!sheetCountRangeInitialized || (boundsChanged && wasFullRange) || rangeOutOfBounds) {
      sheetCountRange = [min, max];
    }
    sheetCountRangeInitialized = true;
    previousSheetCountMin = min;
    previousSheetCountMax = max;
  });

  $effect(() => {
    if (!features.length || !requestedManifestId) return;
    const feature = findFeatureByManifestId(requestedManifestId);
    if (feature) {
      selectedFeatureId = featureId(feature);
      collectionOpen = true;
    }
  });

  $effect(() => {
    const feature = selectedFeature;
    if (!feature) {
      activeManifestRef = null;
      activeManifest = null;
      loadedManifestId = "";
      return;
    }
    const ref = manifestRefForFeature(feature);
    activeManifestRef = ref;
    if (collectionOpen && ref.id && ref.id !== loadedManifestId) void loadManifest(ref);
  });

  async function loadIndex() {
    loadingIndex = true;
    indexError = "";
    try {
      index = await fetchSeriesIndex();
      const requested = requestedManifestId ? findFeatureByManifestId(requestedManifestId) : null;
      if (requested) selectedFeatureId = featureId(requested);
    } catch (caught) {
      indexError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loadingIndex = false;
    }
  }

  async function loadManifest(ref: IiifResource) {
    const manifestId = ref.id;
    loadedManifestId = manifestId;
    loadingManifest = true;
    manifestError = "";
    try {
      const manifest = await fetchManifest(ref);
      if (loadedManifestId === manifestId) activeManifest = manifest;
    } catch (caught) {
      if (loadedManifestId === manifestId) {
        activeManifest = null;
        manifestError = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      if (loadedManifestId === manifestId) loadingManifest = false;
    }
  }

  function selectFeature(id: FeatureId, options: { fit?: boolean } = {}) {
    const feature = featureById(features, id);
    if (!feature) return null;
    selectedFeatureId = featureId(feature);
    filtersOpen = false;
    if (options.fit !== false) fitToSelectedKey += 1;
    return feature;
  }

  function openCollectionFeature(id: FeatureId, options: { fit?: boolean; updateHistory?: boolean } = {}) {
    const feature = selectFeature(id, { fit: options.fit });
    if (!feature) return;
    requestedManifestId = feature.properties?.manifestId || "";
    collectionOpen = true;
    filtersOpen = false;
    if (options.updateHistory !== false) updateManifestUrl(requestedManifestId, "pushState");
  }

  function handleCollectionOpenChange(open: boolean) {
    collectionOpen = open;
    if (!open) {
      requestedManifestId = "";
      updateManifestUrl("", "pushState");
    } else if (selectedFeature) {
      requestedManifestId = selectedFeature.properties?.manifestId || "";
      updateManifestUrl(requestedManifestId, "pushState");
    }
  }

  function resetFilters() {
    activeRegion = allRegions;
    activeScale = allScales;
    if (sheetCountBounds.ready) sheetCountRange = [sheetCountBounds.min, sheetCountBounds.max];
  }

  function setSheetCountRange(nextRange: number[]) {
    if (nextRange.length < 2 || !sheetCountBounds.ready) return;
    sheetCountRangeInitialized = true;
    const min = clamp(Math.round(nextRange[0]), sheetCountBounds.min, sheetCountBounds.max);
    const max = clamp(Math.round(nextRange[1]), sheetCountBounds.min, sheetCountBounds.max);
    sheetCountRange = [Math.min(min, max), Math.max(min, max)];
  }

  function findFeatureByManifestId(manifestId: string) {
    return features.find((feature) => sameManifestId(feature.properties?.manifestId || "", manifestId)) || null;
  }

  function sameManifestId(left: string, right: string) {
    return Boolean(left && right) && (left === right || localUrlPath(left) === localUrlPath(right));
  }

  function localUrlPath(value: string) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }

  function manifestRefForFeature(feature: SeriesIndexFeature): IiifResource {
    const thumbnailId = feature.properties?.thumbnailId;
    return {
      id: feature.properties?.manifestId || "",
      type: "Manifest",
      label: { none: [featureLabel(feature)] },
      thumbnail: thumbnailId ? [{ id: thumbnailId, type: "Image" }] : undefined,
    };
  }

  function updateManifestUrl(manifestId: string, method: "pushState" | "replaceState") {
    if (typeof window === "undefined") return;
    const nextUrl = manifestId ? appBasePath + "?manifest=" + encodeURIComponent(manifestId) : appBasePath;
    if (window.location.pathname + window.location.search === nextUrl) return;
    window.history[method](null, "", nextUrl);
  }

  function normalizeAppBasePath(path: string) {
    if (!path || path === "/") return "/";
    const normalized = path.startsWith("/") ? path : "/" + path;
    return normalized.endsWith("/") ? normalized : normalized + "/";
  }

  function manifestFromLocation() {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("manifest") || "";
  }

  function isFormControl(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("button, input, select, textarea, a, [contenteditable=true], [role=dialog]"));
  }

  function featureMatchesRegion(feature: SeriesIndexFeature, region: string) {
    return region === allRegions || propertyList(feature.properties?.regions).includes(region);
  }

  function featureMatchesScale(feature: SeriesIndexFeature, scale: string) {
    return scale === allScales || propertyList(feature.properties?.scales).includes(scale);
  }

  function featureMatchesSheetCount(feature: SeriesIndexFeature) {
    if (!sheetCountBounds.ready) return true;
    const count = feature.properties?.sheetCount;
    if (typeof count !== "number") return false;
    return count >= sheetCountRange[0] && count <= sheetCountRange[1];
  }

  function sheetBoundsForFeatures(nextFeatures: SeriesIndexFeature[]): SheetCountBounds {
    const counts = nextFeatures
      .map((feature) => feature.properties?.sheetCount)
      .filter((count): count is number => typeof count === "number" && Number.isFinite(count));
    if (!counts.length) return { min: 0, max: 0, ready: false };
    return { min: Math.min(...counts), max: Math.max(...counts), ready: true };
  }

  function formatSheetCountRange(range: number[], bounds: SheetCountBounds) {
    if (!bounds.ready) return "No sheet counts";
    return formatNumber(range[0]) + " - " + formatNumber(range[1]) + " sheets";
  }

  function filterCount() {
    let count = 0;
    if (activeRegion !== allRegions) count += 1;
    if (activeScale !== allScales) count += 1;
    if (sheetCountBounds.ready && (sheetCountRange[0] > sheetCountBounds.min || sheetCountRange[1] < sheetCountBounds.max)) count += 1;
    return count;
  }

  function formatNumber(value: number) {
    return new Intl.NumberFormat("en-US").format(value);
  }

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }
</script>

<div class="app-frame map-first-frame">
  <section class="workspace-shell map-first-shell" class:sidebar-collapsed={!sidePanelOpen}>
    {#if sidePanelOpen}
      <SharedSidebar
      loading={loadingIndex}
      error={indexError}
      {features}
      {listedFeatures}
      filteredCount={filteredFeatures.length}
      {selectedFeatureId}
      boundsActive={Boolean(viewportBbox)}
      onFeatureSelect={(id) => selectFeature(id)}
      onFeatureView={(id) => openCollectionFeature(id, { fit: false })}
      onFeatureHover={(id) => (hoveredFeatureId = id)}
      />
    {/if}

    <main class="workspace-main map-main" aria-label="Gaihozu map browser">
      <MapViewer
        active={true}
        features={filteredFeatures}
        {selectedFeatureId}
        {hoveredFeatureId}
        {polygonsVisible}
        {fitToFeaturesKey}
        {fitToSelectedKey}
        onViewportBboxChange={(bbox) => (viewportBbox = bbox)}
        onSelectFeature={(id) => selectFeature(id, { fit: false })}
        onHoverFeature={(id) => (hoveredFeatureId = id)}
      />

      <section class="map-title-overlay" aria-label="Site title">
        <p>Stanford EarthWorks</p>
        <h1>Gaihozu Index Maps</h1>
      </section>

      <div class="map-action-overlay" aria-label="Map actions">
        <Button.Root class="overlay-button" type="button" aria-label={sidePanelOpen ? "Hide series panel" : "Show series panel"} onclick={() => (sidePanelOpen = !sidePanelOpen)}>
          <ListTree size={18} strokeWidth={2.25} aria-hidden="true" />
          <span class="button-label">Series</span>
        </Button.Root>

        <Popover.Root open={filtersOpen} onOpenChange={(open) => (filtersOpen = open)}>
          <Popover.Trigger class="overlay-button" aria-label="Open filters">
            <Funnel size={18} strokeWidth={2.25} aria-hidden="true" />
            <span class="button-label">Filters</span>
            {#if activeFilterCount > 0}<span class="filter-count">{activeFilterCount}</span>{/if}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content class="filter-popover" side="bottom" align="end" sideOffset={10}>
              <div class="popover-heading">
                <h2>Filters</h2>
                <p>{listedFeatures.length} in view, {filteredFeatures.length} matching filters</p>
              </div>

              <div class="field">
                <span class="field-label">Region</span>
                <Select.Root type="single" value={activeRegion} items={regionItems} onValueChange={(value) => (activeRegion = value)}>
                  <Select.Trigger class="select-trigger" aria-label="Region">
                    <Select.Value placeholder={allRegions} />
                    <span class="select-chevron" aria-hidden="true">v</span>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content class="select-content" sideOffset={5}>
                      <Select.Viewport class="select-viewport">
                        {#each regionItems as item}
                          <Select.Item class="select-item" value={item.value} label={item.label}>{item.label}</Select.Item>
                        {/each}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              <div class="field">
                <span class="field-label">Scale</span>
                <Select.Root type="single" value={activeScale} items={scaleItems} onValueChange={(value) => (activeScale = value)}>
                  <Select.Trigger class="select-trigger" aria-label="Scale">
                    <Select.Value placeholder={allScales} />
                    <span class="select-chevron" aria-hidden="true">v</span>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content class="select-content" sideOffset={5}>
                      <Select.Viewport class="select-viewport">
                        {#each scaleItems as item}
                          <Select.Item class="select-item" value={item.value} label={item.label}>{item.label}</Select.Item>
                        {/each}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              <div class="field scale-field sheet-count-field">
                <span class="range-label-row">
                  <span class="field-label">Sheet count</span>
                  <output>{sheetCountLabel}</output>
                </span>
                <Slider.Root
                  class="range-slider"
                  type="multiple"
                  value={sheetCountRange}
                  min={sheetCountBounds.min}
                  max={sheetCountBounds.max}
                  step={1}
                  disabled={!sheetCountBounds.ready || sheetCountBounds.min === sheetCountBounds.max}
                  onValueChange={setSheetCountRange}
                  aria-label="Sheet count range"
                >
                  <Slider.Range class="slider-range" />
                  <Slider.Thumb class="slider-thumb" index={0} />
                  <Slider.Thumb class="slider-thumb" index={1} />
                </Slider.Root>
              </div>

              <div class="switch-row compact-switch-row">
                <Switch.Root class="switch-root" checked={polygonsEnabled} aria-label="Show polygons" onCheckedChange={(enabled) => (polygonsEnabled = enabled)}>
                  <Switch.Thumb class="switch-thumb" />
                </Switch.Root>
                {#if polygonsVisible}
                  <Eye size={16} strokeWidth={2.2} aria-hidden="true" />
                {:else}
                  <EyeOff size={16} strokeWidth={2.2} aria-hidden="true" />
                {/if}
                <span>{polygonVisibilityLabel}</span>
                <kbd>Hold Space</kbd>
              </div>

              <div class="map-filter-actions">
                <Button.Root class="control-button" type="button" onclick={() => (fitToFeaturesKey += 1)}><Maximize2 size={16} strokeWidth={2.25} aria-hidden="true" />Fit filtered</Button.Root>
                <Button.Root class="control-button secondary" type="button" onclick={resetFilters}><RotateCcw size={16} strokeWidth={2.25} aria-hidden="true" />Reset</Button.Root>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <Dialog.Root open={aboutOpen} onOpenChange={(open) => { aboutOpen = open; if (open) filtersOpen = false; }}>
          <Dialog.Trigger class="overlay-button" aria-label="About this project"><Info size={18} strokeWidth={2.25} aria-hidden="true" /><span class="button-label">About</span></Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay class="dialog-overlay" />
            <Dialog.Content class="dialog-content about-dialog-content">
              <div class="dialog-title-row">
                <Dialog.Title class="dialog-title" level={2}>About This Collection Browser</Dialog.Title>
                <Dialog.Close class="dialog-close" aria-label="Close about dialog"><X size={18} strokeWidth={2.4} aria-hidden="true" /></Dialog.Close>
              </div>
              <section class="about-links" aria-label="Primary resources">
                <a class="data-link" href={collectionPath}><Database size={16} strokeWidth={2.25} aria-hidden="true" /><span>collection.json</span><ExternalLink size={14} strokeWidth={2.25} aria-hidden="true" /></a>
                <a class="data-link" href={seriesIndexPath}><Braces size={16} strokeWidth={2.25} aria-hidden="true" /><span>series-index.geojson</span><ExternalLink size={14} strokeWidth={2.25} aria-hidden="true" /></a>
              </section>

              <Dialog.Description class="dialog-description">
                Explore combined IIIF manifests and dissolved sheet-index footprints for Stanford's Gaihozu map-index records.
              </Dialog.Description>

              <div class="about-copy">
                <section class="collection-description" aria-label="Collection description">
                  <h3>Gaihozu Index Maps</h3>
                  <p>{collectionDescription}</p>
                </section>
                <p>
                  This browser starts from the Stanford EarthWorks collection of Japanese military and imperial map sheet indexes, then builds a browsable IIIF Presentation 3 collection around the scanned sheets.
                </p>
                <p>
                  The data workflow reads EarthWorks and OpenGeoMetadata records, downloads each index GeoJSON or converts the shapefile parts when needed, extracts Stanford PURL IIIF manifest URLs from each sheet feature, and uses <code>@iiif/helpers</code> to upgrade and combine the individual sheet manifests into one series manifest.
                </p>
                <p>
                  Sheet geometries become canvas-level <code>navPlace</code> values, while dissolved sheet-index geometry becomes manifest-level <code>navPlace</code>. The generated root collection also includes browse groupings by all series, broad region, and scale.
                </p>
              </div>

              <dl class="resource-list">
                <div>
                  <dt>Source records</dt>
                  <dd><a href={earthWorksCollectionUrl}>Stanford EarthWorks Gaihozu collection</a> and <a href={openGeoMetadataUrl}>OpenGeoMetadata Stanford metadata</a></dd>
                </div>
                <div>
                  <dt>IIIF and geospatial output</dt>
                  <dd>Local Presentation 3 manifests, collection JSON, GeoJSON sheet indexes, and IIIF <a href={iiifNavPlaceUrl}>NavPlace</a> geometry.</dd>
                </div>
                <div>
                  <dt>Map and interface</dt>
                  <dd><a href={openFreeMapUrl}>OpenFreeMap</a> background tiles, <a href={mapLibreUrl}>MapLibre GL JS</a> rendering, Svelte, and <a href={bitsUiUrl}>Bits UI</a> controls.</dd>
                </div>
              </dl>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>

      <Dialog.Root open={collectionOpen} onOpenChange={handleCollectionOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content collection-dialog-content">
            <div class="dialog-title-row">
              <Dialog.Title class="dialog-title" level={2}>{selectedFeature ? featureLabel(selectedFeature) : "Map Series"}</Dialog.Title>
              <Dialog.Close class="dialog-close" aria-label="Close collection dialog"><X size={18} strokeWidth={2.4} aria-hidden="true" /></Dialog.Close>
            </div>
            <div class="collection-modal-body">
              <ManifestPreview
                manifest={activeManifest}
                manifestRef={activeManifestRef}
                loading={loadingManifest}
                error={manifestError}
                showTitle={false}
              />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  </section>
</div>

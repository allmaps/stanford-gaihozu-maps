<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { pushState } from '$app/navigation';
  import { Dialog, Slider } from 'bits-ui';
  import { ArrowUpRight, Search, SlidersHorizontal, X, Maximize2, RotateCcw, Layers,
    Info, Map as MapIcon, ZoomIn, ZoomOut, Moon, Sun, LocateFixed, Share2 } from '@lucide/svelte';
  import config from '../../../site.config.json';
  import MapViewer from './MapViewer.svelte';
  import ManifestPreview from './ManifestPreview.svelte';
  import { loadCatalog, languageText, navYear, matchesDate, manifestFeature } from '../catalog';
  import type { Catalog } from '../catalog';
  import { fetchJson, fetchManifest, publicPath, localPath } from '../iiif';
  import { featureId, featureLabel, featureBbox, rankForViewport } from '../map-data';
  import type { Bbox } from '../map-data';
  import type { IiifManifest, IiifResource, SeriesIndexFeature } from '../types';

  type MapActions = { zoomIn: () => void; zoomOut: () => void; fitFeature: (feature: SeriesIndexFeature) => void };
  type YearRangeDrag = { pointerId: number; startX: number; trackWidth: number; startYears: [number, number] };
  const copy = config.labels;
  const palette = config.map.palette.colors;
  const densityGradient = `linear-gradient(to right, ${palette[1]}, ${palette[4]}, ${palette[8]})`;
  let mapViewer = $state<MapActions | null>(null);
  let catalog = $state.raw<Catalog | null>(null);
  let loading = $state(true);
  let error = $state('');
  let query = $state('');
  let choices = $state<Record<string, string>>({});
  let years = $state<number[]>([0, 0]);
  let includeUndated = $state(true);
  let viewport = $state<Bbox | null>(null);
  let zoom = $state(config.map.zoom);
  let limitToView = $state(true);
  let polygonsVisible = $state(true);
  let densityEnabled = $state(true);
  let selected = $state<string | number | null>(null);
  let hovered = $state<string | number | null>(null);
  let fitKey = $state(0);
  let filtersOpen = $state(false);
  let sidebarOpen = $state(true);
  let aboutOpen = $state(false);
  let exportOpen = $state(false);
  let darkMode = $state(false);
  let manifestOpen = $state(false);
  let activeRef = $state.raw<IiifResource | null>(null);
  let activeManifest = $state.raw<IiifManifest | null>(null);
  let loadingManifest = $state(false);
  let manifestError = $state('');
  let yearRangeDrag = $state<YearRangeDrag | null>(null);
  let loadSequence = 0;
  let mapArea = $state<HTMLElement>();
  let timelinePanel = $state<HTMLElement>();
  let filterPanel = $state<HTMLDivElement>();
  let filterButton = $state<HTMLButtonElement>();
  let filterMaxHeight = $state(320);

  const title = $derived(config.title || languageText(catalog?.root.label) || '');
  const description = $derived(config.description || languageText(catalog?.root.summary));
  const collectionLabel = $derived(languageText(catalog?.root.label) || 'Collection');
  const collectionDescription = $derived(languageText(catalog?.root.summary));
  const collectionUrl = $derived(catalog?.root.id || `${config.canonicalDataBaseUrl}${config.collection}`);
  const theseusUrl = $derived(`https://theseusviewer.org/?iiif-content=${encodeURIComponent(collectionUrl)}`);
  const allmapsUrl = $derived(`https://editor.allmaps.org/images?url=${encodeURIComponent(collectionUrl)}`);
  const manifests = $derived(catalog?.manifests || []);
  const dated = $derived(manifests.map(navYear).filter((year): year is number => year !== null));
  const dateBounds = $derived(dated.length ? [Math.min(...dated), Math.max(...dated)] : [0, 0]);
  const browseFiltered = $derived(manifests.filter(manifest => {
    const text = `${languageText(manifest.label)} ${languageText(manifest.summary)}`.toLocaleLowerCase();
    if (query && !text.includes(query.toLocaleLowerCase())) return false;
    return (catalog?.facets || []).every(facet => {
      const choice = choices[facet.id];
      return !choice || facet.options.find(option => option.id === choice)?.members.has(manifest.id);
    });
  }));
  const undatedCount = $derived(browseFiltered.filter(manifest => navYear(manifest) === null).length);
  const filtered = $derived(browseFiltered.filter(manifest => matchesDate(manifest, years, includeUndated)));
  const features = $derived(filtered.map(manifestFeature));
  const mapped = $derived(features.filter(feature => Boolean(featureBbox(feature))));
  const displayed = $derived(rankForViewport(mapped, viewport, config.map.maxPolygons, selected, config.map.containmentMargin));
  const listed = $derived(limitToView ? displayed : features);
  const activeFilters = $derived(Object.values(choices).filter(Boolean).length + (includeUndated ? 0 : 1));
  const histogram = $derived.by(() => {
    const bins = Array.from({ length: 44 }, () => 0);
    const visibleYears = browseFiltered.map(navYear).filter((year): year is number => year !== null);
    for (const year of visibleYears) bins[Math.min(43, Math.floor((year - dateBounds[0]) / Math.max(1, dateBounds[1] - dateBounds[0]) * 43))]++;
    return bins;
  });

  $effect(() => {
    if (!filtersOpen || !mapArea || !timelinePanel) return;
    const observer = new ResizeObserver(updateFilterPanelHeight);
    observer.observe(mapArea);
    observer.observe(timelinePanel);
    updateFilterPanelHeight();
    return () => observer.disconnect();
  });

  onMount(() => {
    const savedTheme = localStorage.getItem('atlas-theme');
    setDarkMode(savedTheme ? savedTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches, false);
    void initialize();
    const handleHistory = () => {
      const id = new URLSearchParams(location.search).get('manifest');
      const ref = catalog?.manifests.find(manifest => manifest.id === id);
      if (ref) void openManifest(ref, false);
      else manifestOpen = false;
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!filtersOpen || !(target instanceof Node)) return;
      if (!filterPanel?.contains(target) && !filterButton?.contains(target)) filtersOpen = false;
    };
    window.addEventListener('popstate', handleHistory);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('popstate', handleHistory);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  });

  async function initialize() {
    loading = true; error = '';
    try {
      const loaded = await loadCatalog(publicPath(config.collection), url => fetchJson<IiifResource>(localPath(url)));
      const knownYears = loaded.manifests.map(navYear).filter((year): year is number => year !== null);
      years = knownYears.length ? [Math.min(...knownYears), Math.max(...knownYears)] : [0, 0];
      catalog = loaded;
      const id = new URLSearchParams(location.search).get('manifest');
      const ref = loaded.manifests.find(manifest => manifest.id === id);
      if (ref) void openManifest(ref, false);
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { loading = false; }
  }
  async function openManifest(ref: IiifResource, history = true) {
    selected = ref.id; activeRef = ref; activeManifest = null; manifestError = '';
    loadingManifest = true; manifestOpen = true;
    const sequence = ++loadSequence;
    if (history) { const url = new URL(location.href); url.searchParams.set('manifest', ref.id); pushState(url, {}); }
    try { const manifest = await fetchManifest(ref); if (sequence === loadSequence) activeManifest = manifest; }
    catch (caught) { if (sequence === loadSequence) manifestError = String(caught); }
    finally { if (sequence === loadSequence) loadingManifest = false; }
  }
  function closeManifest(open: boolean) {
    manifestOpen = open;
    if (!open) { const url = new URL(location.href); url.searchParams.delete('manifest'); pushState(url, {}); }
  }
  function reset() {
    query = '';
    choices = {};
    years = [...dateBounds];
    includeUndated = true;
    limitToView = true;
    selected = null;
  }
  function updateFilterPanelHeight() {
    if (!mapArea || !timelinePanel) return;
    const mapTop = mapArea.getBoundingClientRect().top;
    const timelineTop = timelinePanel.getBoundingClientRect().top;
    filterMaxHeight = Math.max(1, Math.floor(timelineTop - mapTop - 8));
  }
  function startYearRangeDrag(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const range = event.currentTarget as HTMLElement;
    const track = range.parentElement;
    if (event.button !== 0 || !track || dateBounds[0] === dateBounds[1]) return;
    const [start, end] = years;
    if (start === dateBounds[0] && end === dateBounds[1]) return;
    range.setPointerCapture(event.pointerId);
    yearRangeDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      trackWidth: track.getBoundingClientRect().width,
      startYears: [start, end],
    };
  }
  function moveYearRange(event: PointerEvent) {
    if (!yearRangeDrag || event.pointerId !== yearRangeDrag.pointerId || !yearRangeDrag.trackWidth) return;
    const yearSpan = dateBounds[1] - dateBounds[0];
    const requestedDelta = Math.round((event.clientX - yearRangeDrag.startX) / yearRangeDrag.trackWidth * yearSpan);
    const delta = Math.max(
      dateBounds[0] - yearRangeDrag.startYears[0],
      Math.min(dateBounds[1] - yearRangeDrag.startYears[1], requestedDelta),
    );
    years = [yearRangeDrag.startYears[0] + delta, yearRangeDrag.startYears[1] + delta];
  }
  function endYearRangeDrag(event: PointerEvent) {
    if (yearRangeDrag?.pointerId === event.pointerId) yearRangeDrag = null;
  }
  function select(id: string | number) { selected = id; sidebarOpen = true; }
  function toggleSelection(id: string | number) { selected = selected === id ? null : id; }
  async function selectFromMap(id: string | number) {
    select(id);
    await tick();
    document.getElementById(cardId(id))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function zoomToFeature(feature: SeriesIndexFeature) {
    selected = featureId(feature);
    mapViewer?.fitFeature(feature);
  }
  function updateViewport(bounds: Bbox, nextZoom: number) { viewport = bounds; zoom = nextZoom; }
  function cardId(id: string | number) { return `resource-${String(id).replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
  function setDarkMode(value: boolean, persist = true) {
    darkMode = value;
    document.documentElement.classList.toggle('dark', value);
    if (persist) localStorage.setItem('atlas-theme', value ? 'dark' : 'light');
  }
</script>

<svelte:head><title>{title || 'IIIF map collection'}</title><meta name="description" content={description} /></svelte:head>

<div class="flex h-dvh flex-col bg-stone-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
  <header class="z-10 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900 md:px-6">
    <a class="flex min-w-0 items-center gap-3 text-slate-900 no-underline dark:text-white" href={publicPath('/')} aria-label={title || 'Collection home'}>
      <span class="grid size-10 shrink-0 place-items-center rounded-xl border border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300"><MapIcon size={21} strokeWidth={1.7} /></span>
      {#if title}<strong class="truncate text-lg font-semibold tracking-tight md:text-xl">{title}</strong>{/if}
    </a>
    <div class="relative flex items-center gap-2">
      <button class="grid size-9 place-items-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" onclick={() => exportOpen = !exportOpen} aria-label="Open export menu" aria-expanded={exportOpen}><Share2 size={18} /></button>
      {#if exportOpen}<div class="absolute top-11 right-0 z-30 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white/90 p-1.5 text-sm shadow-xl backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/90"><a class="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800" href={theseusUrl} target="_blank" rel="noreferrer">Open in Theseus<ArrowUpRight size={15} /></a><a class="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800" href={allmapsUrl} target="_blank" rel="noreferrer">Open in Allmaps<ArrowUpRight size={15} /></a><a class="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800" href={localPath(collectionUrl)} target="_blank" rel="noreferrer">IIIF Collection JSON<ArrowUpRight size={15} /></a></div>{/if}
      <button class="grid size-9 place-items-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" onclick={() => setDarkMode(!darkMode)} aria-label={darkMode ? 'Use light mode' : 'Use dark mode'}>{#if darkMode}<Sun size={18} />{:else}<Moon size={18} />{/if}</button>
      <button class="grid size-9 place-items-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" onclick={() => aboutOpen = true} aria-label={copy.about}><Info size={18} /></button>
    </div>
  </header>

  <div class={`flex min-h-0 flex-1 flex-col-reverse md:grid ${sidebarOpen ? 'md:grid-cols-[360px_minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,1fr)]'}`}>
    <aside class="z-10 flex h-[42%] min-h-0 flex-col border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:h-auto md:border-r md:border-t-0" aria-label="Collection results" hidden={!sidebarOpen}>
      <div class="border-b border-slate-200 p-3 dark:border-slate-800 md:p-4">
        <label class="flex h-11 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-slate-500 focus-within:ring-2 focus-within:ring-teal-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400"><Search size={17} /><input class="min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-900 outline-none dark:text-white" aria-label={copy.search} placeholder={copy.search} bind:value={query} />{#if query}<button class="rounded p-1" aria-label="Clear search" onclick={() => query = ''}><X size={15} /></button>{/if}</label>
        <h1 class="mt-3 mb-0 text-sm font-semibold">{listed.length} results <span class="font-normal text-slate-500 dark:text-slate-400">of {filtered.length} resources</span></h1>
      </div>

      <div class="themed-scrollbar flex-1 overflow-auto p-2" aria-live="polite" aria-busy={loading}>
        {#if loading}<div class="flex items-center gap-3 p-6 text-sm text-slate-500"><span class="size-4 animate-spin rounded-full border-2 border-slate-200 border-t-teal-600"></span>{copy.loading}</div>
        {:else if error}<div class="grid gap-3 p-6 text-sm text-red-700" role="alert"><p>{error}</p><button class="w-fit rounded-lg border px-3 py-2" onclick={initialize}>Try again</button></div>
        {:else if !listed.length}<div class="grid gap-3 p-6 text-sm text-slate-500">{copy.empty}<button class="w-fit rounded-lg border px-3 py-2" onclick={reset}>Clear filters</button></div>
        {:else}
          {#each listed as feature (featureId(feature))}
            {@const id = featureId(feature)}
            {@const ref = manifests.find(manifest => manifest.id === id)!}
            <article id={cardId(id)} class={`my-1 scroll-m-4 rounded-xl border transition-colors ${selected === id ? 'border-teal-500 bg-teal-50 dark:bg-teal-950' : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800'}`} onmouseenter={() => hovered = id} onmouseleave={() => hovered = null}>
              <button class="flex w-full items-start gap-3 rounded-xl bg-transparent p-3 text-left" onclick={() => toggleSelection(id)} aria-pressed={selected === id}>
                {#if feature.properties.thumbnailId}<img class="h-20 w-[70px] shrink-0 rounded-md border border-slate-200 bg-stone-100 object-cover dark:border-slate-700 dark:bg-slate-950" src={feature.properties.thumbnailId} alt="" loading="lazy" />{:else}<span class="grid h-20 w-[70px] shrink-0 place-items-center rounded-md bg-slate-100 text-slate-400 dark:bg-slate-800"><MapIcon size={24} /></span>{/if}
                <span class="flex min-w-0 flex-1 flex-col gap-1.5"><span class="text-[10px] font-semibold tracking-wide text-teal-700 dark:text-teal-300">{navYear(ref) ?? 'Undated'}</span><strong class="line-clamp-3 text-xs leading-5 font-semibold">{featureLabel(feature)}</strong><span class="text-[10px] text-slate-500 dark:text-slate-400">{copy.item}{#if !featureBbox(feature)} · No location{/if}</span></span>
              </button>
              {#if selected === id}
                <div class="px-3 pb-3"><p class="line-clamp-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{languageText(ref.summary)}</p><div class="mt-3 grid grid-cols-2 gap-2"><button class="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800" onclick={() => openManifest(ref)}>{copy.open}<ArrowUpRight size={15} /></button>{#if featureBbox(feature)}<button class="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" onclick={() => zoomToFeature(feature)}><LocateFixed size={15} />Zoom to extent</button>{/if}</div></div>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    </aside>

    <main bind:this={mapArea} class="relative min-h-[230px] min-w-0 flex-1 overflow-hidden" aria-label="Collection map">
      <MapViewer bind:this={mapViewer} features={displayed} densityFeatures={mapped} selectedFeatureId={selected} hoveredFeatureId={hovered}
        {polygonsVisible} {densityEnabled} {darkMode} fitToFeaturesKey={fitKey} onViewportChange={updateViewport} onSelectFeature={selectFromMap} onHoverFeature={id => hovered = id} />

      <div class="absolute top-3 left-3 flex gap-2 md:top-4 md:left-4">
        <button class="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white/90 px-3 text-xs font-semibold shadow-md backdrop-blur-md hover:bg-white dark:border-slate-700 dark:bg-slate-900/90 dark:hover:bg-slate-900" onclick={() => sidebarOpen = !sidebarOpen} aria-label={sidebarOpen ? 'Hide results' : 'Show results'}><Layers size={17} /><span class="hidden sm:inline">{sidebarOpen ? 'Hide results' : 'Show results'}</span></button>
        <button class="grid size-10 place-items-center rounded-xl border border-slate-200 bg-white/90 shadow-md backdrop-blur-md hover:bg-white dark:border-slate-700 dark:bg-slate-900/90 dark:hover:bg-slate-900" onclick={() => fitKey++} aria-label="Fit matching footprints"><Maximize2 size={17} /></button>
        <button class={`h-10 rounded-xl border px-3 text-xs font-semibold shadow-md backdrop-blur-md ${polygonsVisible ? 'border-teal-600 bg-teal-50/90 text-teal-800 dark:bg-teal-950/90 dark:text-teal-200' : 'border-slate-200 bg-white/90 dark:border-slate-700 dark:bg-slate-900/90'}`} onclick={() => polygonsVisible = !polygonsVisible} aria-pressed={polygonsVisible}>Footprints</button>
        <button class={`h-10 rounded-xl border px-3 text-xs font-semibold shadow-md backdrop-blur-md ${densityEnabled ? 'border-emerald-600 bg-emerald-50/90 text-emerald-800 dark:bg-emerald-950/90 dark:text-emerald-200' : 'border-slate-200 bg-white/90 dark:border-slate-700 dark:bg-slate-900/90'}`} onclick={() => densityEnabled = !densityEnabled} aria-pressed={densityEnabled}>Density</button>
      </div>

      <div class="absolute top-3 right-3 grid overflow-hidden rounded-xl border border-slate-200 bg-white/90 shadow-md backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/90 md:top-4 md:right-4">
        <button class="grid size-10 place-items-center border-b border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" onclick={() => mapViewer?.zoomIn()} aria-label="Zoom in"><ZoomIn size={18} /></button>
        <button class="grid size-10 place-items-center hover:bg-slate-50 dark:hover:bg-slate-800" onclick={() => mapViewer?.zoomOut()} aria-label="Zoom out"><ZoomOut size={18} /></button>
      </div>

      {#if polygonsVisible || densityEnabled}<div class="absolute top-16 left-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-[10px] text-slate-600 shadow-md backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-300 md:top-[4.5rem] md:left-4">{#if polygonsVisible}<span class="h-2.5 w-4 border" style:background-color={palette[4]} style:border-color={palette[7]}></span>{displayed.length} footprints{/if}{#if densityEnabled}<span class:ml-2={polygonsVisible} class="h-2.5 w-6 rounded-full" style:background={densityGradient}></span>{zoom < config.map.densityMinZoom ? 'Coverage density' : 'Coverage + heat'}{/if}</div>{/if}

      {#if dated.length}
        <section bind:this={timelinePanel} class="absolute bottom-3 left-1/2 w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-xl border border-slate-200 bg-white/90 p-3 shadow-xl backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/90 md:bottom-4" aria-label={copy.timeline}>
          {#if filtersOpen}
            <div bind:this={filterPanel} class="themed-scrollbar absolute right-0 bottom-full mb-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-auto rounded-xl border border-slate-200 bg-white/90 p-4 shadow-xl backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/90" style:max-height={`${filterMaxHeight}px`}>
              <div class="mb-4 flex items-center justify-between"><h3 class="m-0 text-sm font-semibold">Filters</h3><button class="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onclick={reset}>Reset all</button></div>
              <div class="grid gap-3">
                {#each catalog?.facets || [] as facet (facet.id)}
                  <label class="grid gap-1.5 text-xs font-medium"><span>{facet.label}</span><select class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950" aria-label={facet.label} value={choices[facet.id] || ''} onchange={event => choices = { ...choices, [facet.id]: event.currentTarget.value }}><option value="">{copy.all}</option>{#each facet.options as option}<option value={option.id}>{option.label} ({option.members.size})</option>{/each}</select></label>
                {/each}
              </div>
              <div class="mt-4 grid gap-2 border-t border-slate-200 pt-4 text-xs dark:border-slate-700">
                <label class="flex cursor-pointer items-center gap-2"><input class="size-4 accent-teal-600" type="checkbox" bind:checked={includeUndated} />{copy.undated} ({undatedCount})</label>
                <label class="flex cursor-pointer items-center gap-2"><input class="size-4 accent-teal-600" type="checkbox" bind:checked={limitToView} />Search within map view</label>
              </div>
            </div>
          {/if}
          <div class="flex items-center justify-between gap-3"><div class="min-w-0 text-xs"><span class="font-medium text-slate-500 dark:text-slate-400">{copy.timeline}</span><span class="ml-2 font-semibold tabular-nums text-slate-800 dark:text-slate-100">{years[0]}–{years[1]}</span></div><div class="flex shrink-0 gap-1"><button bind:this={filterButton} class={`relative grid size-8 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 ${filtersOpen ? 'bg-teal-50 dark:bg-teal-950' : ''}`} aria-label="Show collection filters" aria-expanded={filtersOpen} onclick={() => filtersOpen = !filtersOpen}><SlidersHorizontal size={16} />{#if activeFilters}<span class="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-teal-700 text-[9px] font-bold text-white">{activeFilters}</span>{/if}</button><button class="grid size-8 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Reset all filters and search" onclick={reset}><RotateCcw size={16} /></button></div></div>
          <div class="mt-1 flex h-5 items-end gap-[3px] px-1" aria-hidden="true">{#each histogram as count, i}{@const outside = dateBounds[0] + i / 43 * (dateBounds[1] - dateBounds[0]) < years[0] || dateBounds[0] + i / 43 * (dateBounds[1] - dateBounds[0]) > years[1]}<span class={`min-h-0.5 flex-1 rounded-t-sm transition-[height,background-color] duration-200 ${outside ? 'bg-slate-200 dark:bg-slate-700' : 'bg-teal-500'}`} style:height={`${Math.max(5, count / Math.max(1, ...histogram) * 100)}%`}></span>{/each}</div>
          <Slider.Root type="multiple" class="relative flex h-5 w-full touch-none items-center before:absolute before:inset-x-0 before:h-1 before:rounded-full before:bg-slate-200 dark:before:bg-slate-700" min={dateBounds[0]} max={dateBounds[1]} step={1} value={years} onValueChange={value => years = value} disabled={dateBounds[0] === dateBounds[1]} aria-label="Year range"><Slider.Range class={`absolute z-10 h-5 touch-none cursor-grab before:absolute before:inset-x-0 before:top-1/2 before:h-1 before:-translate-y-1/2 before:rounded-full before:bg-teal-600 ${yearRangeDrag ? 'cursor-grabbing' : ''}`} aria-label="Drag selected year range" onpointerdown={startYearRangeDrag} onpointermove={moveYearRange} onpointerup={endYearRangeDrag} onpointercancel={endYearRangeDrag} /><Slider.Thumb class="relative z-20 block size-4 rounded-full border-[3px] border-white bg-teal-700 shadow-[0_0_0_1px_#0f766e] focus:outline-none dark:border-slate-900" index={0} aria-label="Start year" /><Slider.Thumb class="relative z-20 block size-4 rounded-full border-[3px] border-white bg-teal-700 shadow-[0_0_0_1px_#0f766e] focus:outline-none dark:border-slate-900" index={1} aria-label="End year" /></Slider.Root>
          <div class="mt-1 flex justify-between text-[10px] text-slate-500 dark:text-slate-400"><span>{dateBounds[0]}</span><span>{filtered.length} matching</span><span>{dateBounds[1]}</span></div>
        </section>
      {/if}
    </main>
  </div>
</div>

<Dialog.Root open={manifestOpen} onOpenChange={closeManifest}><Dialog.Portal><Dialog.Overlay class="fixed inset-0 z-20 bg-slate-950/60 backdrop-blur-sm" /><Dialog.Content class="themed-scrollbar fixed top-1/2 left-1/2 z-30 max-h-[90dvh] w-[min(70rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900 md:p-7"><div class="mb-5 flex items-start justify-between gap-5"><Dialog.Title class="m-0 text-xl font-semibold">{languageText(activeRef?.label) || copy.item}</Dialog.Title><Dialog.Close class="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close images"><X size={20} /></Dialog.Close></div><Dialog.Description class="sr-only">Images and metadata from the selected IIIF manifest.</Dialog.Description><ManifestPreview manifest={activeManifest} manifestRef={activeRef} loading={loadingManifest} error={manifestError} showTitle={false} /></Dialog.Content></Dialog.Portal></Dialog.Root>

<Dialog.Root bind:open={aboutOpen}><Dialog.Portal><Dialog.Overlay class="fixed inset-0 z-20 bg-slate-950/60 backdrop-blur-sm" /><Dialog.Content class="themed-scrollbar fixed top-1/2 left-1/2 z-30 max-h-[90dvh] w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-slate-200 bg-white p-6 text-sm leading-7 shadow-2xl dark:border-slate-700 dark:bg-slate-900"><div class="mb-5 flex items-start justify-between gap-5"><Dialog.Title class="m-0 text-xl font-semibold">{collectionLabel}</Dialog.Title><Dialog.Close class="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close about"><X size={20} /></Dialog.Close></div><Dialog.Description class="text-slate-600 dark:text-slate-300">{collectionDescription}</Dialog.Description><div class="mt-5 flex flex-wrap gap-x-5 gap-y-2 font-medium text-teal-700 dark:text-teal-300">{#each catalog?.root.homepage || [] as link}<a class="underline" href={link.id} target="_blank" rel="noreferrer">{languageText(link.label) || link.id} ↗</a>{/each}<a class="underline" href={localPath(collectionUrl)} target="_blank" rel="noreferrer">IIIF Collection ↗</a>{#if config.repository.url}<a class="underline" href={config.repository.url} target="_blank" rel="noreferrer">{config.repository.label} ↗</a>{/if}</div><div class="mt-5 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">Map tiles by <a class="underline" href="https://openfreemap.org/">OpenFreeMap</a> and <a class="underline" href="https://openmaptiles.org/">OpenMapTiles</a>. Map data © <a class="underline" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.</div></Dialog.Content></Dialog.Portal></Dialog.Root>

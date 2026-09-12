<script lang="ts">
  import { onMount, tick } from "svelte";
  import CollectionNav from "./CollectionNav.svelte";
  import ManifestPreview from "./ManifestPreview.svelte";
  import { countManifests, fetchCollection, fetchManifest, firstManifest } from "../iiif";
  import type { IiifManifest, IiifResource } from "../types";

  type Props = {
    requestedManifestId?: string;
    onManifestSelected?: (manifestId: string) => void;
  };

  let { requestedManifestId = "", onManifestSelected = () => {} }: Props = $props();

  let navEl = $state.raw<HTMLElement | null>(null);
  let collection = $state<IiifResource | null>(null);
  let activeManifestRef = $state<IiifResource | null>(null);
  let activeManifest = $state<IiifManifest | null>(null);
  let loadingCollection = $state<boolean>(true);
  let loadingManifest = $state<boolean>(false);
  let error = $state<string>("");
  let lastAppliedManifestId = $state<string>("");

  let collectionItems = $derived<IiifResource[]>(collection?.items || []);
  let manifestCount = $derived(countManifests(collectionItems));
  let groupCount = $derived(collectionItems.length);

  onMount(() => {
    void loadCollection();
  });

  $effect(() => {
    if (!activeManifestRef) return;
    void scrollActiveManifestIntoView();
  });

  $effect(() => {
    if (!collection || !requestedManifestId || requestedManifestId === lastAppliedManifestId) return;
    if (activeManifestRef && sameManifestId(activeManifestRef.id, requestedManifestId)) {
      lastAppliedManifestId = requestedManifestId;
      return;
    }
    const target = findManifest(collection.items || [], requestedManifestId);
    lastAppliedManifestId = requestedManifestId;
    if (target) void selectManifest(target, { notify: false });
  });

  async function loadCollection() {
    loadingCollection = true;
    error = "";
    try {
      collection = await fetchCollection();
      const target = requestedManifestId ? findManifest(collection.items || [], requestedManifestId) : undefined;
      const first = target || firstManifest(collection.items || []);
      if (first) await selectManifest(first, { notify: false });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loadingCollection = false;
    }
  }

  function findManifest(items: IiifResource[], manifestId: string): IiifResource | undefined {
    for (const item of items) {
      if (item.type === "Manifest" && sameManifestId(item.id, manifestId)) return item;
      const child = findManifest(item.items || [], manifestId);
      if (child) return child;
    }
    return undefined;
  }

  function sameManifestId(left: string, right: string) {
    return left === right || localUrlPath(left) === localUrlPath(right);
  }

  function localUrlPath(value: string) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }

  async function scrollActiveManifestIntoView() {
    await tick();
    navEl?.querySelector<HTMLElement>(".series-button.is-active")?.scrollIntoView({ block: "nearest" });
  }

  async function selectManifest(ref: IiifResource, options: { notify?: boolean } = {}) {
    activeManifestRef = ref;
    loadingManifest = true;
    error = "";
    if (options.notify !== false) onManifestSelected(ref.id);
    try {
      activeManifest = await fetchManifest(ref);
    } catch (caught) {
      activeManifest = null;
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loadingManifest = false;
    }
  }
</script>

<section class="shell collection-shell">
  <aside class="sidebar">
    <div class="brand">
      <h1>Series</h1>
    </div>

    <div class="status">
      {#if loadingCollection}
        Loading collection...
      {:else if error && !collection}
        {error}
      {:else}
        {manifestCount} manifests across {groupCount} browse groups
      {/if}
    </div>

    <nav class="series-list" aria-label="IIIF collection navigation" bind:this={navEl}>
      <CollectionNav
        items={collectionItems}
        activeManifestId={activeManifestRef?.id || ""}
        onSelect={selectManifest}
      />
    </nav>
  </aside>

  <section class="viewer">
    <ManifestPreview
      manifest={activeManifest}
      manifestRef={activeManifestRef}
      loading={loadingManifest}
      error={error && collection ? error : ""}
    />
  </section>
</section>

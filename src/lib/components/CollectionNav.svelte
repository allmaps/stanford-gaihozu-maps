<script lang="ts">
  import { Accordion, Button } from "bits-ui";
  import { countManifests, label } from "../iiif";
  import type { IiifResource } from "../types";
  import CollectionNav from "./CollectionNav.svelte";

  type Props = {
    items: IiifResource[];
    depth?: number;
    activeManifestId?: string;
    onSelect: (item: IiifResource) => void;
  };

  let { items, depth = 0, activeManifestId = "", onSelect }: Props = $props();

  let initializedKey = $state<string>("");
  let openGroupIds = $state<string[]>([]);

  $effect(() => {
    const key = items.map((item) => item.id).join("\0");
    if (key === initializedKey) return;
    initializedKey = key;
    openGroupIds = depth === 0 ? items.filter((item) => item.type === "Collection").map((item) => item.id) : [];
  });
</script>

<Accordion.Root class="nav-accordion" type="multiple" bind:value={openGroupIds}>
  {#each items as item (item.id)}
    {#if item.type === "Collection"}
      <Accordion.Item class="nav-group" value={item.id} style={"--depth: " + depth}>
        <Accordion.Header class="nav-heading" level={depth === 0 ? 2 : 3}>
          <Accordion.Trigger class="nav-summary">
            <span>{label(item.label) || item.id}</span>
            <span class="nav-count">{countManifests(item.items || [])}</span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content class="nav-children">
          <CollectionNav
            items={item.items || []}
            depth={depth + 1}
            {activeManifestId}
            {onSelect}
          />
        </Accordion.Content>
      </Accordion.Item>
    {:else if item.type === "Manifest"}
      <Button.Root
        class={item.id === activeManifestId ? "series-button is-active" : "series-button"}
        type="button"
        style={"--depth: " + depth}
        data-manifest-id={item.id}
        onclick={() => onSelect(item)}
      >
        {label(item.label) || item.id}
      </Button.Root>
    {/if}
  {/each}
</Accordion.Root>

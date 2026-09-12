<script lang="ts">
  import { Button } from "bits-ui";

  type Mode = "collection" | "map";

  type Props = {
    active: Mode;
    onModeChange?: (mode: Mode) => void;
  };

  let { active, onModeChange }: Props = $props();

  const modes: Array<{ id: Mode; label: string; href: string }> = [
    { id: "collection", label: "Collection", href: "/" },
    { id: "map", label: "Map", href: "/map.html" },
  ];

  function handleModeClick(event: MouseEvent, mode: Mode) {
    if (!onModeChange) return;
    event.preventDefault();
    onModeChange(mode);
  }
</script>

<header class="mode-header">
  <Button.Root class="mode-brand" href="/">Gaihozu IIIF</Button.Root>
  <nav class="mode-switch" aria-label="Preview mode">
    {#each modes as mode}
      <Button.Root
        class="mode-tab"
        href={mode.href}
        aria-current={active === mode.id ? "page" : undefined}
        onclick={(event) => handleModeClick(event, mode.id)}
      >
        {mode.label}
      </Button.Root>
    {/each}
  </nav>
  <div class="mode-links">
    <Button.Root class="utility-link" href="/iiif/collection.json">collection.json</Button.Root>
    <Button.Root class="utility-link" href="/iiif/series-index.geojson">series-index.geojson</Button.Root>
  </div>
</header>

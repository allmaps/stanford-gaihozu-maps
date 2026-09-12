<script lang="ts">
  import "maplibre-gl/dist/maplibre-gl.css";
  import "../styles.css";

  let { children } = $props();
</script>

<svelte:head>
  <title>Gaihozu Index Maps</title>
  <meta
    name="description"
    content="A static IIIF and GeoJSON browser for Stanford EarthWorks Gaihozu index maps."
  />
</svelte:head>

{@render children()}

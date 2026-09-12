import { mount } from "svelte";
import UnifiedApp from "./entries/UnifiedApp.svelte";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Missing #app element");
}

mount(UnifiedApp, { target });

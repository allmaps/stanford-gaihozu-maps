import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

declare const process: { env: { PUBLIC_URL?: string } };

const publicUrl = process.env.PUBLIC_URL;
const base = publicUrl ? new URL(publicUrl).pathname.replace(/\/?$/, "/") : "/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Range",
};

export default defineConfig({
  base,
  plugins: [svelte()],
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    cors: true,
    headers: corsHeaders,
  },
  preview: {
    host: "127.0.0.1",
    port: 5174,
    cors: true,
    headers: corsHeaders,
  },
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        map: "map.html",
      },
    },
  },
});

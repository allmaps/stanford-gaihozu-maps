import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Range",
};

export default defineConfig({
  plugins: [sveltekit()],
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
});

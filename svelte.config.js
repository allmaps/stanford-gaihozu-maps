import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const publicUrl = process.env.PUBLIC_URL;
const basePath = publicUrl ? new URL(publicUrl).pathname.replace(/\/?$/, "") : "";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: "dist",
      assets: "dist",
    }),
    paths: {
      base: basePath === "/" ? "" : basePath,
    },
  },
};

export default config;

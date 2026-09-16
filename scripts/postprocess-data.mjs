#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareIiif } from './prepare-iiif.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = trimTrailingSlash(
  args["base-url"] || process.env.BASE_URL || process.env.PUBLIC_URL || "http://localhost:5173",
);
const staticDir = path.resolve(args["static-dir"] || process.env.STATIC_DIR || "static");
const iiifDir = path.join(staticDir, "iiif");
const rewriteHosts = new Set(["localhost", "127.0.0.1", "pages.allmaps.org"]);

await main();
await prepareIiif(staticDir);

async function main() {
  if (!existsSync(iiifDir)) {
    throw new Error("IIIF data directory not found: " + path.relative(process.cwd(), iiifDir));
  }

  const jsonFiles = [];
  for await (const file of walk(iiifDir)) {
    if (/\.(?:json|geojson)$/i.test(file)) jsonFiles.push(file);
  }

  let changedFiles = 0;
  let rewrittenValues = 0;
  for (const file of jsonFiles) {
    const text = await readFile(file, "utf8");
    const data = JSON.parse(text);
    const result = rewriteLocalDataUrls(data);
    if (result.changed) {
      await writeJson(file, result.value);
      changedFiles += 1;
      rewrittenValues += result.count;
    }
  }

  console.log(
    "Postprocessed " +
      jsonFiles.length +
      " IIIF JSON files; rewrote " +
      rewrittenValues +
      " local data URL" +
      (rewrittenValues === 1 ? "" : "s") +
      " in " +
      changedFiles +
      " file" +
      (changedFiles === 1 ? "" : "s") +
      ".",
  );
  console.log("Base URL: " + baseUrl);
}

function rewriteLocalDataUrls(value) {
  if (typeof value === "string") {
    const rewritten = rewriteLocalDataUrl(value);
    return {
      value: rewritten,
      changed: rewritten !== value,
      count: rewritten === value ? 0 : 1,
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    let count = 0;
    const array = value.map((item) => {
      const result = rewriteLocalDataUrls(item);
      changed ||= result.changed;
      count += result.count;
      return result.value;
    });
    return { value: array, changed, count };
  }

  if (value && typeof value === "object") {
    let changed = false;
    let count = 0;
    const object = {};
    for (const [key, item] of Object.entries(value)) {
      const result = rewriteLocalDataUrls(item);
      changed ||= result.changed;
      count += result.count;
      object[key] = result.value;
    }
    return { value: object, changed, count };
  }

  return { value, changed: false, count: 0 };
}

function rewriteLocalDataUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (!rewriteHosts.has(url.hostname)) return value;
  const marker = localDataPathIndex(url.pathname);
  if (marker === -1) return value;

  return baseUrl + url.pathname.slice(marker) + url.search + url.hash;
}

function localDataPathIndex(pathname) {
  const iiifIndex = pathname.indexOf("/iiif/");
  const geojsonIndex = pathname.indexOf("/geojson/");
  if (iiifIndex === -1) return geojsonIndex;
  if (geojsonIndex === -1) return iiifIndex;
  return Math.min(iiifIndex, geojsonIndex);
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function writeJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

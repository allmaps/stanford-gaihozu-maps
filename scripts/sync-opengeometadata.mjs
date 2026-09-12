#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoUrl = "https://github.com/OpenGeoMetadata/edu.stanford.purl.git";
const target = path.resolve(
  process.argv[2] || ".cache/opengeometadata/edu.stanford.purl",
);

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

if (existsSync(path.join(target, ".git"))) {
  console.log(`Updating ${target}`);
  await run("git", ["-C", target, "pull", "--ff-only"]);
} else {
  console.log(`Cloning ${repoUrl} into ${target}`);
  await mkdir(path.dirname(target), { recursive: true });
  await run("git", [
    "clone",
    "--depth",
    "1",
    "--filter=blob:none",
    repoUrl,
    target,
  ]);
}

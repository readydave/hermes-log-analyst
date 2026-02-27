#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const env = { ...process.env };

if (process.platform === "linux") {
  delete env.LD_LIBRARY_PATH;
  if (!env.WEBKIT_DISABLE_DMABUF_RENDERER) {
    env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
  }
}

const require = createRequire(import.meta.url);
const cliPackagePath = require.resolve("@tauri-apps/cli/package.json");
const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));
const binField = cliPackage.bin;
const binRelative =
  typeof binField === "string"
    ? binField
    : binField?.tauri ?? Object.values(binField ?? {})[0];

if (!binRelative || typeof binRelative !== "string") {
  console.error("Unable to resolve @tauri-apps/cli binary entrypoint.");
  process.exit(1);
}

const cliEntrypoint = path.resolve(path.dirname(cliPackagePath), binRelative);
const command = process.execPath;
const args = [cliEntrypoint, ...process.argv.slice(2)];

const child = spawn(command, args, {
  env,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(`Failed to launch Tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

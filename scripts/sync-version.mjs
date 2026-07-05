#!/usr/bin/env node
/**
 * Syncs the version from package.json to Cargo.toml and tauri.conf.json.
 *
 * Usage:
 *   pnpm bump          # sync current version everywhere
 *   pnpm bump 1.0.0    # set + sync a new version
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(fileURLToPath(import.meta.url), "../..");

// Optionally accept a new version as argument
const newVersion = process.argv[2];

const rootPkg = resolve(root, "package.json");
const rootJson = JSON.parse(readFileSync(rootPkg, "utf-8"));

if (newVersion) {
  if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
    console.error(`Invalid version: ${newVersion}`);
    process.exit(1);
  }
  rootJson.version = newVersion;
  const rootRaw = readFileSync(rootPkg, "utf-8");
  const rootEol = rootRaw.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(rootPkg, JSON.stringify(rootJson, null, 2).replace(/\n/g, rootEol) + rootEol);
}

const version = rootJson.version;

// tauri.conf.json: update "version" field
const tauriConf = resolve(root, "src-tauri/tauri.conf.json");
const raw = readFileSync(tauriConf, "utf-8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const json = JSON.parse(raw);
json.version = version;
writeFileSync(tauriConf, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);

// Cargo.toml: replace version in [package] section
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
let cargo = readFileSync(cargoPath, "utf-8");
cargo = cargo.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
writeFileSync(cargoPath, cargo);

console.log(`Version synced to ${version}.`);

#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "export-manifest.json");

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error("export-manifest.json is missing; this check only runs in a generated public export");
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (manifest.schemaVersion !== "pmf.public_contracts_export.v2") {
    throw new Error(`unsupported export schema: ${manifest.schemaVersion}`);
  }
  if (!manifest.sourceRevision || !/^[0-9a-f]{40}$/.test(manifest.sourceRevision)) {
    throw new Error("manifest sourceRevision must be a full Git commit hash");
  }
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("manifest files map is missing");
  }

  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    const absolute = path.resolve(ROOT, relative);
    const withinRoot = path.relative(ROOT, absolute);
    if (withinRoot.startsWith("..") || path.isAbsolute(withinRoot)) {
      throw new Error(`manifest path escapes repository: ${relative}`);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`manifest file is missing: ${relative}`);
    }
    const actualHash = sha256(fs.readFileSync(absolute));
    if (actualHash !== expectedHash) {
      throw new Error(`manifest hash mismatch: ${relative}`);
    }
  }

  const solidityFiles = Object.keys(manifest.files).filter((relative) => relative.endsWith(".sol")).sort();
  const solidityDigest = sha256(
    solidityFiles.map((relative) => `${relative}\0${manifest.files[relative]}\n`).join("")
  );
  if (solidityDigest !== manifest.soliditySourceDigest) {
    throw new Error("manifest Solidity source digest does not match its file map");
  }

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    schemaVersion: manifest.schemaVersion,
    sourceRevision: manifest.sourceRevision,
    sourceTreeClean: manifest.sourceTreeClean,
    files: Object.keys(manifest.files).length,
    solidityFiles: solidityFiles.length,
    soliditySourceDigest: solidityDigest,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

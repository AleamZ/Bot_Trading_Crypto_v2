import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const apiBaseUrl =
  process.env.VITE_API_BASE_URL ??
  process.env.API_BASE_URL ??
  "/api";

// Cloudflare and browsers cache .css/.js for 4h while index.html is not cached, so in dist every URL of
// these assets carries ?v=<content hash>: a new index.html never runs with an old stylesheet or module.
const assetFiles = ["styles.css", "app.js", "apiClient.js", ...(await listFiles("chart"))].sort();
const assetVersion = await hashFiles(assetFiles);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  cp(join(root, "index.html"), join(dist, "index.html")),
  cp(join(root, "app.js"), join(dist, "app.js")),
  cp(join(root, "apiClient.js"), join(dist, "apiClient.js")),
  cp(join(root, "styles.css"), join(dist, "styles.css")),
  cp(join(root, "chart"), join(dist, "chart"), { recursive: true })
]);

await Promise.all([
  stampAssetVersion("index.html", (text) =>
    text.replace(/\b(href|src)="((?:\.?\/)?)([^"?#]+)(?:\?v=[^"]*)?"/g, (url, attribute, prefix, path) =>
      assetFiles.includes(path) ? `${attribute}="${prefix}${path}?v=${assetVersion}"` : url
    )
  ),
  // Relative module specifiers, static (`from "./x.js"`) or dynamic (`import("./x.js")`), so modules imported
  // by a versioned module are versioned too and apiClient.js stays one module instance.
  ...assetFiles
    .filter((file) => file.endsWith(".js"))
    .map((file) =>
      stampAssetVersion(file, (text) =>
        text.replace(
          /(\b(?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"'?]+\.js)(?:\?v=[^"']*)?\2/g,
          `$1$2$3?v=${assetVersion}$2`
        )
      )
    )
]);
await Promise.all([
  requireVersionedUrls("index.html", ["/styles.css", "./app.js"]),
  requireVersionedUrls("app.js", ["./chart/Chart.js"])
]);

const configText = `window.__APP_CONFIG__ = ${JSON.stringify({ API_BASE_URL: apiBaseUrl })};\n`;
await Promise.all([writeFile(join(dist, "config.js"), configText), writeFile(join(dist, "app-config.js"), configText)]);
console.log(`Web build: ${assetFiles.length} assets versioned ?v=${assetVersion} in ${dist}`);

async function listFiles(dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listFiles(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]))
  );
  return files.flat();
}

async function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0`).update(await readFile(join(root, file))).update("\0");
  return hash.digest("hex").slice(0, 10);
}

async function stampAssetVersion(file, stamp) {
  const path = join(dist, file);
  await writeFile(path, stamp(await readFile(path, "utf8")));
}

// A URL the stamping no longer recognises would silently ship unversioned and be served stale for hours.
async function requireVersionedUrls(file, urls) {
  const text = await readFile(join(dist, file), "utf8");
  const missing = urls.filter((url) => !text.includes(`${url}?v=${assetVersion}`));
  if (missing.length > 0) {
    throw new Error(`Web build: ${missing.join(", ")} in ${file} did not get ?v=${assetVersion}; update scripts/build.mjs`);
  }
}

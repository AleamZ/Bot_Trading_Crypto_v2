import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const apiBaseUrl =
  process.env.VITE_API_BASE_URL ??
  process.env.API_BASE_URL ??
  "/api";

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  cp(join(root, "index.html"), join(dist, "index.html")),
  cp(join(root, "app.js"), join(dist, "app.js")),
  cp(join(root, "apiClient.js"), join(dist, "apiClient.js")),
  cp(join(root, "styles.css"), join(dist, "styles.css")),
  cp(join(root, "chart"), join(dist, "chart"), { recursive: true })
]);
const configText = `window.__APP_CONFIG__ = ${JSON.stringify({ API_BASE_URL: apiBaseUrl })};\n`;
await Promise.all([writeFile(join(dist, "config.js"), configText), writeFile(join(dist, "app-config.js"), configText)]);

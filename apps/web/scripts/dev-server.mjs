import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let localEnv = {};
try {
  const envText = await readFile(join(root, ".env"), "utf8");
  localEnv = Object.fromEntries(
    envText
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^(?:\"|')(.*)(?:\"|')$/, "$1")])
  );
} catch {
  // Local .env is optional; process environment remains authoritative.
}

const port = Number(process.env.WEB_PORT ?? process.env.PORT ?? 5173);
const apiBaseUrl =
  process.env.VITE_API_BASE_URL ??
  process.env.API_BASE_URL ??
  localEnv.VITE_API_BASE_URL ??
  localEnv.API_BASE_URL ??
  "http://localhost:8787";

await writeFile(
  join(root, "app-config.js"),
  `window.__APP_CONFIG__ = ${JSON.stringify({ API_BASE_URL: apiBaseUrl })};\n`
);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const file = normalize(join(root, pathname.replace(/^\//, "")));
    const relativePath = relative(root, file);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Invalid path");
    const body = await readFile(file);
    response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Web listening on http://localhost:${port}`);
  console.log(`API base URL: ${apiBaseUrl}`);
});

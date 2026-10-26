import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { dirname } from "node:path";
import { Readable } from "node:stream";
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
const proxyTarget = process.env.LOCAL_API_PROXY_TARGET ?? "https://bot-trade-feature-binance.vercel.app";
const apiBaseUrl =
  process.env.VITE_API_BASE_URL ??
  process.env.API_BASE_URL ??
  localEnv.VITE_API_BASE_URL ??
  localEnv.API_BASE_URL ??
  "/api";

const configText = `window.__APP_CONFIG__ = ${JSON.stringify({ API_BASE_URL: apiBaseUrl })};\n`;
await Promise.all([writeFile(join(root, "config.js"), configText), writeFile(join(root, "app-config.js"), configText)]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await proxyApiRequest(request, response, requestUrl);
      return;
    }

    const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const file = normalize(join(root, pathname.replace(/^\//, "")));
    const relativePath = relative(root, file);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Invalid path");
    const body = await readFile(file);
    response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    // A proxied stream the browser already closed has nothing left to answer.
    if (response.headersSent || response.destroyed) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Web listening on http://localhost:${port}`);
  console.log(`API base URL: ${apiBaseUrl}`);
  console.log(`API proxy target: ${proxyTarget}`);
});

async function proxyApiRequest(request, response, requestUrl) {
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, proxyTarget);
  const headers = proxyRequestHeaders(request.headers);
  const body = await readRequestBody(request);
  // Abort the upstream call when the browser goes away (long-lived event streams).
  const upstreamAbort = new AbortController();
  response.on("close", () => upstreamAbort.abort());
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: body.length > 0 && request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
    signal: upstreamAbort.signal
  });
  const responseHeaders = proxyResponseHeaders(upstream.headers);
  const setCookies = readSetCookies(upstream.headers).map(rewriteDevSetCookie);
  if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;
  response.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    response.end();
    return;
  }
  // Pipe instead of buffering so Server-Sent Events reach the browser as they are written.
  Readable.fromWeb(upstream.body)
    .on("error", () => response.destroy())
    .pipe(response);
}

function proxyRequestHeaders(headers) {
  const forwarded = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "origin", "referer"].includes(lower)) continue;
    forwarded[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return forwarded;
}

function proxyResponseHeaders(headers) {
  const forwarded = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (["connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding"].includes(lower)) return;
    forwarded[lower] = value;
  });
  return forwarded;
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function rewriteDevSetCookie(cookie) {
  return cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part) && !/^secure$/i.test(part))
    .map((part) => (/^samesite=/i.test(part) ? "SameSite=Lax" : part))
    .join("; ");
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

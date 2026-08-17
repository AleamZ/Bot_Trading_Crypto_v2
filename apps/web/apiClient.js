const configuredBaseUrl = window.__APP_CONFIG__?.API_BASE_URL ?? "";

export const API_BASE_URL = configuredBaseUrl.replace(/\/+$/, "");

export function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (API_BASE_URL === "/api" && normalizedPath.startsWith("/api/")) {
    return `${API_BASE_URL}${normalizedPath.slice(4)}`;
  }

  return `${API_BASE_URL}${normalizedPath}`;
}

export async function apiFetch(path, options) {
  const response = await fetch(apiUrl(path), { credentials: "include", ...(options ?? {}) });
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new CustomEvent("auth:unauthorized"));
  }
  return response;
}

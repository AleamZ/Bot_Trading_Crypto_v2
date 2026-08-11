const configuredBaseUrl = window.__APP_CONFIG__?.API_BASE_URL ?? "";

export const API_BASE_URL = configuredBaseUrl.replace(/\/+$/, "");

export function apiUrl(path) {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiFetch(path, options) {
  return fetch(apiUrl(path), options);
}

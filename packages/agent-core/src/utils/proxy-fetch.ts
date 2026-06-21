/**
 * Proxy fetch utilities.
 *
 * Manages HTTP/HTTPS proxy configuration for the native `fetch()` calls
 * made by Scream Code (FetchURL tool, HTTP MCP clients, etc.).
 *
 * Node.js 24's native `fetch()` respects `http_proxy` / `https_proxy`
 * environment variables internally. This module sets/clears those variables
 * once at session startup so all outbound requests from any component
 * route through the proxy correctly.
 *
 * For the local LLM provider (e.g. `localhost:3099`), `NO_PROXY` is set
 * automatically when proxy is active so inference traffic is never
 * tunneled.
 */

import type { ProxyConfig } from '#/config/schema';

const PROXY_ENV_VARS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'] as const;
const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'] as const;
const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * Apply proxy configuration to the current process environment.
 *
 * Call this once at session startup (before any `fetch()` calls). The
 * effect persists for the lifetime of the process — safe for a single-
 * session CLI tool, but intentionally NOT safe for long-running multi-
 * session daemons.
 *
 * | mode  | behaviour                                                  |
 * |-------|------------------------------------------------------------|
 * | `off` | Unset all proxy env vars (no proxy)                        |
 * | `on`  | Set http_proxy/https_proxy to config.url (or default 7827) |
 * | `auto`| No-op — respect whatever is already in the environment      |
 */
export function applyProxyConfig(proxy?: ProxyConfig): void {
  if (!proxy || proxy.mode === 'auto') {
    return;
  }

  if (proxy.mode === 'off') {
    for (const key of PROXY_ENV_VARS) {
      delete process.env[key];
    }
    for (const key of NO_PROXY_VARS) {
      delete process.env[key];
    }
    return;
  }

  // mode === 'on'
  const proxyUrl = proxy.url ?? 'http://127.0.0.1:7827';
  for (const key of PROXY_ENV_VARS) {
    process.env[key] = proxyUrl;
  }
  // Ensure localhost/loopback traffic is excluded
  for (const key of NO_PROXY_VARS) {
    process.env[key] = LOCAL_NO_PROXY;
  }
}

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MARKETPLACE_FILE = resolve(SCRIPT_DIR, '..', '..', '..', 'plugins', 'marketplace.json');

/**
 * Starts a local mock server for the plugin marketplace.
 * Serves the checked-in marketplace.json so `pnpm dev` does not
 * need to hit the GitHub CDN during development.
 *
 * @returns {Promise<{ marketplaceUrl: string, close: () => Promise<void> }>}
 */
export async function startPluginMarketplaceServer() {
  const marketplaceBody = await readFile(MARKETPLACE_FILE, 'utf-8');

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(marketplaceBody);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Plugin marketplace dev server failed to bind to a port');
  }

  const marketplaceUrl = `http://127.0.0.1:${address.port}/marketplace.json`;

  return {
    marketplaceUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

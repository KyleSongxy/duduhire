import { defineConfig } from 'vite';
import { sites } from './build/sites-vite-plugin.js';

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    appType: 'mpa',
    plugins: [
      sites(),
      cloudflare({
        config: {
          main: './worker/index.js',
          compatibility_flags: ['nodejs_compat'],
        },
      }),
    ],
  };
});

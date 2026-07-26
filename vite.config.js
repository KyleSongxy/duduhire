import { defineConfig } from 'vite';
import { sites } from './build/sites-vite-plugin.js';
import hostingConfig from './.openai/hosting.json' with { type: 'json' };

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID = '00000000-0000-4000-8000-000000000000';

const localBindingConfig = {
  main: './worker/index.js',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: hostingConfig.d1
    ? [{
        binding: hostingConfig.d1,
        database_name: 'duduhire-operations',
        database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
      }]
    : [],
};

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    appType: 'mpa',
    base: './',
    plugins: [
      sites(),
      cloudflare({
        config: localBindingConfig,
      }),
    ],
  };
});

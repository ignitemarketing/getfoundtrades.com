import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://getfoundtrades.com',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'always' },
  // Emit every processed script as a file under /_astro/ instead of inlining it, so the
  // Content-Security-Policy in public/_headers can use script-src 'self' without hashes.
  vite: { build: { assetsInlineLimit: 0 } },
});

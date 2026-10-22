import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://getfoundtrades.com',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'always' },
});

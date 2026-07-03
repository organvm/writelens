import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        kvNamespaces: ['WL_RATE', 'WL_KEYS'],
        bindings: {
          PAYRAIL_URL: 'https://payrail.ivixivi.workers.dev'
        }
      }
    })
  ]
});


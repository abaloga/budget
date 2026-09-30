import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache well across deploys.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(recharts|d3-|victory-vendor|es-toolkit|decimal\.js)/.test(id)) return 'vendor-charts';
          if (id.includes('node_modules/@supabase/')) return 'vendor-supabase';
          if (/node_modules\/(react|react-dom|scheduler|react-router)\//.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
});

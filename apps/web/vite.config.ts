import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React and the router change rarely: their own file stays cached across deploys.
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:4100',
    },
  },
});

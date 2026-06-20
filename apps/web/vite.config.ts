import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@sphere-2048/game': path.resolve(__dirname, '../../packages/game/src/index.ts'),
      '@sphere-2048/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/functions/v1': {
        target: process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        changeOrigin: true,
      },
    },
  },
});
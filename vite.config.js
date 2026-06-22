import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const hmrEnabled = process.env.PULSEPOINT_HMR === '1';

export default defineConfig({
  logLevel: 'error',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    allowedHosts: true,
    hmr: hmrEnabled ? undefined : false,
    watch: {
      ignored: [
        '**/data/**',
        '**/android/**',
        '**/dist/**',
        '**/*.mp4',
        '**/*.m4v',
        '**/*.mov',
        '**/*.webm',
        '**/*.mkv',
        '**/*.wav',
        '**/*.mp3',
        '**/*.m4a',
        '**/*.sqlite',
        '**/*.sqlite-*',
      ],
    },
    proxy: {
      '/api': 'http://localhost:8787',
      '/uploads': 'http://localhost:8787',
    },
  },
})

import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  server: {
    watch: {
      usePolling: true,
      interval: 100,
      ignored: ['**/dist/**', '**/tiles/**', '**/weather/**', '**/*.mbtiles', '**/*.db*']
    },
    proxy: {
      // Proxies airport lookup and database endpoints
      '/airport': 'http://localhost:8600',
      '/airportlist': 'http://localhost:8600',
      '/databaselist': 'http://localhost:8600',
      '/tiles': 'http://localhost:8600',
      '/api': {
        target: 'http://localhost:8600',
        ws: true
      }
    }
  },
  build: {
    outDir: '../dist',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/map.html',
      external: ['./ol-layerswitcher.js'], // Explicitly externalize ol-layerswitcher
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]'
      }
    },
    chunkSizeWarningLimit: 3000, // Increase chunk size warning limit to 2000 kB
  },
  publicDir: '../public'
});
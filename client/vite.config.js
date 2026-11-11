import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBackendTarget() {
  const settingsPath = path.resolve(__dirname, '../settings.json');
  let port = 8600;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const configuredPort = parseInt(parsed?.httpport, 10);
    if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535) {
      port = configuredPort;
    }
  } catch (err) {
    console.warn(`Unable to read httpport from ${settingsPath}, defaulting Vite proxy to ${port}:`, err.message);
  }
  return `http://localhost:${port}`;
}

const backendTarget = getBackendTarget();

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
      '/airport': backendTarget,
      '/airportlist': backendTarget,
      '/appsettings': backendTarget,
      '/databaselist': backendTarget,
      '/tiles': backendTarget,
      '/api': {
        target: backendTarget,
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
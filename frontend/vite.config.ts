import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'path'
import { execSync } from 'node:child_process'

// HTTPS is required for getUserMedia (microphone) when accessing the dev server
// from a non-localhost host. Use VITE_HTTPS=1 to enable a self-signed cert.
const useHttps = process.env.VITE_HTTPS === '1'
const buildVersion = process.env.CC_APP_VERSION || getBuildVersion()
const buildTime = new Date().toISOString()

function getBuildVersion() {
  try {
    const commit = execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (commit) return commit
  } catch {
    // Fall back below when git metadata is unavailable.
  }
  return `dev-${Date.now()}`
}

function versionAssetPlugin(): Plugin {
  return {
    name: 'cc-version-asset',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: buildVersion, built_at: buildTime }, null, 2),
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    versionAssetPlugin(),
    ...(useHttps ? [basicSsl()] : []),
  ],
  define: {
    __CC_APP_VERSION__: JSON.stringify(buildVersion),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})

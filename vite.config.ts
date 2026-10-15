/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Strict Content Security Policy, injected only into production builds (the dev server needs
 * inline scripts for React Fast Refresh). The only server the app may talk to is the configured
 * Supabase project (HTTPS for data and auth, WSS for Realtime); without one it talks to nothing.
 */
function buildCsp(supabaseUrl: string): string {
  const connect = ["'self'"];
  if (supabaseUrl) {
    const u = new URL(supabaseUrl);
    connect.push(u.origin, `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function cspPlugin(supabaseUrl: string): Plugin {
  const csp = buildCsp(supabaseUrl);
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

/** Stops a build that would ship a secret key or an insecure API URL to every visitor. */
function checkPublicEnv(url: string, key: string, mode: string): void {
  if (key.startsWith('sb_secret_')) {
    throw new Error(
      'VITE_SUPABASE_PUBLISHABLE_KEY is a secret key. Use the publishable (anon) key.',
    );
  }
  const jwtPayload = key.split('.')[1];
  if (jwtPayload) {
    try {
      const role = JSON.parse(Buffer.from(jwtPayload, 'base64url').toString('utf8')).role;
      if (role === 'service_role') {
        throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY is the service_role key. Use the anon key.');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('service_role')) throw e;
    }
  }
  if (url && mode === 'production') {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) {
      throw new Error(`VITE_SUPABASE_URL must use https (got ${url}).`);
    }
  }
}

/**
 * `--mode artifact` builds a variant for the Claude artifact viewer: relative asset paths, a separate
 * entry (artifact.html) and no service worker or CSP meta (the viewer applies its own policy).
 */
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const supabaseUrl = artifact ? '' : (env.VITE_SUPABASE_URL ?? '');
  checkPublicEnv(supabaseUrl, env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '', mode);
  return {
    base: artifact ? './' : '/',
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: artifact
      ? {
          outDir: 'dist-artifact',
          emptyOutDir: true,
          copyPublicDir: false,
          rollupOptions: { input: 'artifact.html' },
        }
      : {},
    plugins: [
      react(),
      !artifact && cspPlugin(supabaseUrl),
      !artifact &&
        VitePWA({
          registerType: 'prompt',
          injectRegister: false,
          includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
          manifest: {
            id: '/',
            name: 'Personal Finance Hub',
            short_name: 'Finance Hub',
            description:
              'Personal and small-business budgeting (ZAR) that syncs between your devices.',
            lang: 'en-ZA',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            orientation: 'any',
            background_color: '#0f1115',
            theme_color: '#0f1115',
            icons: [
              { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
              { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
              {
                src: 'pwa-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
              },
            ],
          },
          workbox: {
            globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
            navigateFallback: '/index.html',
            // Only the app shell is cached. API and auth calls always go to the network.
            runtimeCaching: [],
          },
        }),
    ],
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      // UI integration tests drive real IndexedDB queries; allow headroom on slower machines.
      testTimeout: 15_000,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});

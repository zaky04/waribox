import { cpSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const currentDir = dirname(fileURLToPath(import.meta.url));

// Numéro de version affiché dans Paramètres → Maintenance — une seule
// source pour les trois plateformes (PWA/desktop/Android, un seul build web
// partagé) : apps/desktop/package.json, déjà celui qui nomme les
// installeurs livrés (WariBox_X.Y.Z...) et tauri.conf.json, donc le numéro
// que l'utilisateur associe déjà à une version donnée de l'app.
const desktopPackageJson = JSON.parse(
  readFileSync(resolve(currentDir, "../desktop/package.json"), "utf-8"),
) as { version: string };

// sqlite-wasm est un bundle Emscripten qui localise son .wasm par chemin
// relatif à sa PROPRE URL de script à l'exécution (moduleScript.src/import.meta.url).
// Rollup renomme (hash) les fichiers en production, ce qui casse cette relation
// relative. Fix : copier le dossier dist/ du package tel quel (fichiers non
// renommés, toujours côte à côte) dans public/, ainsi que notre propre worker
// applicatif (packages/database/src/sahpool-worker.js, qui importe index.mjs
// par chemin relatif) — construits comme des Worker manuels vers ces chemins
// statiques dans packages/database/src/client.ts, jamais laissés au bundler.
function copySqliteWasmAssets() {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@sqlite.org/sqlite-wasm/package.json");
  const sourceDir = resolve(dirname(packageJsonPath), "dist");
  cpSync(sourceDir, resolve(currentDir, "public/sqlite-wasm"), { recursive: true });
  cpSync(
    resolve(currentDir, "../../packages/database/src/sahpool-worker.js"),
    resolve(currentDir, "public/db-worker.js"),
  );
  return { name: "copy-sqlite-wasm-assets" };
}

// Les en-têtes COOP/COEP sont requis pour que SQLite WASM puisse utiliser
// SharedArrayBuffer + persister via OPFS (Origin Private File System).
// configureServer (dev) et configurePreviewServer (`vite preview`) sont deux
// hooks distincts — l'un sans l'autre laisse la moitié des workflows de test
// sans isolation cross-origin. L'hébergement de production devra définir ces
// mêmes en-têtes de son côté (ce plugin ne couvre que les serveurs Vite).
function crossOriginIsolationPlugin() {
  const setHeaders = (
    _req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    next: () => void,
  ) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  };
  return {
    name: "cross-origin-isolation",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use(setHeaders);
    },
    configurePreviewServer(server: import("vite").PreviewServer) {
      server.middlewares.use(setHeaders);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    copySqliteWasmAssets(),
    crossOriginIsolationPlugin(),
    VitePWA({
      // "prompt" plutôt que "autoUpdate" : une vente en cours ne doit pas être
      // interrompue par un rechargement automatique de l'app.
      registerType: "prompt",
      manifest: {
        name: "WariBox",
        short_name: "WariBox",
        description: "Application universelle de gestion de commerce (POS offline-first)",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
        // Le binaire WASM SQLite peut dépasser la limite par défaut de 2 Mo.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(desktopPackageJson.version),
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
});

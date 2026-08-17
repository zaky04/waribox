#!/usr/bin/env node
// Rassemble les livrables des trois cibles (PWA, Windows, Android) dans
// releases/ après un build — ne touche jamais au code source, uniquement
// les artefacts déjà produits par `pnpm build` / `pnpm build:desktop` /
// `pnpm tauri android build` (ce dernier tourne sous WSL, voir README).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releasesDir = join(root, "releases");

function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function copyMatching(sourceDir, destDir, predicate) {
  if (!existsSync(sourceDir)) return [];
  const copied = [];
  for (const name of readdirSync(sourceDir)) {
    if (!predicate(name)) continue;
    cpSync(join(sourceDir, name), join(destDir, name));
    copied.push(name);
  }
  return copied;
}

// --- PWA : copie intégrale du build Vite, prête à déployer telle quelle ---
const pwaDist = join(root, "apps/web/dist");
const pwaDest = join(releasesDir, "pwa");
if (existsSync(pwaDist)) {
  resetDir(pwaDest);
  cpSync(pwaDist, pwaDest, { recursive: true });
  console.log(`PWA copiée dans releases/pwa (${pwaDist})`);
} else {
  console.log("PWA introuvable — lance `pnpm build` d'abord.");
}

// --- Windows : NSIS (.exe) + MSI, produits par `pnpm build:desktop` ---
const windowsDest = join(releasesDir, "windows");
resetDir(windowsDest);
const nsisDir = join(root, "apps/desktop/src-tauri/target/release/bundle/nsis");
const msiDir = join(root, "apps/desktop/src-tauri/target/release/bundle/msi");
const exeFiles = copyMatching(nsisDir, windowsDest, (n) => n.endsWith(".exe"));
const msiFiles = copyMatching(msiDir, windowsDest, (n) => n.endsWith(".msi"));
if (exeFiles.length || msiFiles.length) {
  console.log(`Windows copié dans releases/windows : ${[...exeFiles, ...msiFiles].join(", ")}`);
} else {
  console.log("Installeur Windows introuvable — lance `pnpm build:desktop` d'abord.");
}

// --- Android : APK signé, produit par `pnpm --filter @gestion-boutique/desktop tauri android build` ---
// Le nom exact dépend de la config de signature Gradle (voir
// gen/android/app/build.gradle.kts + gen/android/keystore.properties, tous
// deux ignorés par git comme tout `gen/`) : "app-universal-release.apk" (sans
// suffixe) quand un signingConfig release est appliqué, sinon
// "app-universal-release-unsigned.apk" — jamais copié, il ne s'installe sur
// aucun appareil réel.
const androidDest = join(releasesDir, "android");
resetDir(androidDest);
const apkDir = join(
  root,
  "apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release",
);
const apkFiles = copyMatching(apkDir, androidDest, (n) => n.endsWith(".apk") && !n.endsWith("-unsigned.apk"));
if (apkFiles.length) {
  console.log(`Android copié dans releases/android : ${apkFiles.join(", ")}`);
} else {
  console.log(
    "APK signé introuvable — lance `pnpm --filter @gestion-boutique/desktop tauri android build` avec un signingConfig configuré (voir gen/android/keystore.properties).",
  );
}

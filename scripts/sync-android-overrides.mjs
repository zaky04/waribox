// Réapplique sur le projet Android GÉNÉRÉ (apps/desktop/src-tauri/gen, ignoré par git) les deux
// réglages qui ne vivent que là :
//   1. MainActivity.kt — la version versionnée est apps/desktop/android-overrides/MainActivity.kt
//      (pont natif du mode plein écran, WariBoxNative.setImmersive) ;
//   2. usesCleartextTraffic = "true" dans app/build.gradle.kts — sans lui le WebView Android
//      bloque la connexion ws:// vers le Maître du mode réseau en version release.
// À lancer après tout `tauri android init` (ou une suppression de gen/), et avant un build Android :
//   pnpm android:sync            applique
//   pnpm android:sync --check    vérifie seulement (code de sortie 1 si un réglage manque)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overrides = join(root, "apps/desktop/android-overrides/MainActivity.kt");
const gen = join(root, "apps/desktop/src-tauri/gen/android/app");
const targetActivity = join(gen, "src/main/java/com/waribox/app/MainActivity.kt");
const gradle = join(gen, "build.gradle.kts");
const checkOnly = process.argv.includes("--check");

if (!existsSync(gen)) {
  console.log("Pas de projet Android généré (apps/desktop/src-tauri/gen/android) : rien à faire. Lancez d'abord `pnpm --filter @gestion-boutique/desktop tauri android init`.");
  process.exit(checkOnly ? 1 : 0);
}

let missing = 0;

// 1. MainActivity.kt
const wantedActivity = readFileSync(overrides);
const currentActivity = existsSync(targetActivity) ? readFileSync(targetActivity) : null;
if (currentActivity && currentActivity.equals(wantedActivity)) {
  console.log("MainActivity.kt : à jour.");
} else if (checkOnly) {
  console.log("MainActivity.kt : DIFFÉRENT de apps/desktop/android-overrides/MainActivity.kt.");
  missing++;
} else {
  copyFileSync(overrides, targetActivity);
  console.log("MainActivity.kt : copié depuis android-overrides.");
}

// 2. usesCleartextTraffic
if (existsSync(gradle)) {
  const text = readFileSync(gradle, "utf-8");
  const pattern = /manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"(true|false)"/g;
  const matches = [...text.matchAll(pattern)];
  const wrong = matches.filter((m) => m[1] !== "true");
  if (matches.length > 0 && wrong.length === 0) {
    console.log("usesCleartextTraffic : déjà à true.");
  } else if (checkOnly) {
    console.log("usesCleartextTraffic : manquant ou à false dans build.gradle.kts.");
    missing++;
  } else if (matches.length > 0) {
    writeFileSync(gradle, text.replace(pattern, 'manifestPlaceholders["usesCleartextTraffic"] = "true"'));
    console.log(`usesCleartextTraffic : ${wrong.length} valeur(s) passée(s) à true.`);
  } else {
    console.log('usesCleartextTraffic : aucune ligne trouvée dans build.gradle.kts — ajoutez manifestPlaceholders["usesCleartextTraffic"] = "true" dans defaultConfig et dans le type de build release.');
    missing++;
  }
} else {
  console.log("build.gradle.kts introuvable.");
  missing++;
}

process.exit(missing > 0 ? 1 : 0);

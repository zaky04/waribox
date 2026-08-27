import { isAndroidTauriRuntime, saveNativeDocument } from "@gestion-boutique/sync";

// Point d'entrée unique pour "enregistrer ce document généré" (reçu, ticket,
// étiquettes, export de rapport PDF/Excel...), remplaçant les nombreuses
// copies locales de downloadBlob() qui existaient par fichier. Sur Android,
// le WebView Tauri n'a aucun gestionnaire de téléchargement intégré — un
// clic sur <a download> n'y produit simplement aucun effet — donc on écrit
// le fichier nativement (voir packages/sync/nativeFolder.ts) plutôt que de
// compter sur le mécanisme de téléchargement du navigateur, qui ne fonctionne
// que sur les vraies plateformes navigateur (desktop, PWA) où il est resté
// inchangé.
export async function saveGeneratedFile(blob: Blob, filename: string): Promise<void> {
  if (isAndroidTauriRuntime()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await saveNativeDocument(filename, bytes);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

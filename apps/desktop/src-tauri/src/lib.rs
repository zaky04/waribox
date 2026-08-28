use tauri::{WebviewUrl, WebviewWindowBuilder};

// Purge le service worker et son cache AVANT tout script de la page —
// injecté nativement (WebView2/WKWebView `AddScriptToExecuteOnDocumentCreated`,
// pas soumis à la CSP de la page, comme le pont IPC de Tauri lui-même), donc
// s'exécute même si un service worker périmé sert encore un ancien bundle
// JS qui, lui, ne pourrait jamais se corriger tout seul (voir CLAUDE.md,
// journal "l'app reste bloquée sur du JS obsolète après une mise à jour" —
// vu en pratique sur Android ET desktop : la mise à jour remplace bien le
// binaire, mais l'ancien service worker continue de servir l'ancien
// JavaScript en cache indéfiniment, `registerType: "prompt"` ne le
// remplaçant que sur un clic explicite sur la bannière de mise à jour, que
// personne ne voit jamais dans une appli plein écran). Ne touche pas à
// IndexedDB/OPFS (les données de l'utilisateur) — seulement le service
// worker et son cache, de toute façon inutiles sur Tauri qui sert déjà tout
// localement sans jamais avoir besoin d'un cache hors-ligne.
const RESET_STALE_SERVICE_WORKER_SCRIPT: &str = r#"
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) reg.unregister();
  });
}
if ('caches' in window) {
  caches.keys().then((keys) => {
    for (const key of keys) caches.delete(key);
  });
}
"#;

// Point d'entrée partagé desktop + mobile — main.rs (desktop) et la coquille
// Android générée par `tauri android init` appellent tous les deux run().
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // tauri-plugin-android-fs : écriture dans le stockage public Android
    // (MediaStore) pour les sauvegardes et documents générés — voir
    // CLAUDE.md, journal sur l'écriture native Android. Uniquement Android,
    // ce crate ne compile pas sur les autres plateformes.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    builder
        .setup(|app| {
            // La fenêtre est créée ici plutôt que déclarée dans
            // tauri.conf.json (`app.windows`) — c'est le seul moyen d'y
            // attacher un script d'initialisation natif. Le CSP/les
            // en-têtes de sécurité de tauri.conf.json (`app.security`)
            // restent appliqués globalement, indépendamment de comment la
            // fenêtre est créée.
            let mut window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("WariBox")
                .initialization_script(RESET_STALE_SERVICE_WORKER_SCRIPT);
            #[cfg(desktop)]
            {
                window_builder = window_builder
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(1024.0, 700.0);
            }
            window_builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}

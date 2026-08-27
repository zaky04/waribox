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
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}

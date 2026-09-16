mod discovery;
mod network;

// Point d'entrée partagé desktop + mobile — main.rs (desktop) et la coquille
// Android générée par `tauri android init` appellent tous les deux run().
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Mode réseau local — serveur Master (voir network.rs) + découverte
        // mDNS côté Worker (voir discovery.rs). Enregistrés sur toutes les
        // plateformes : rien n'empêche de compiler ces modules sur
        // Android/mobile, mais seul le rôle Master (toujours PC/desktop,
        // voir CLAUDE.md) héberge réellement un serveur — la découverte,
        // elle, est utile à un Worker Tauri, desktop comme Android.
        .manage(network::MasterServerState::default())
        .manage(discovery::DiscoveryState::default())
        .invoke_handler(tauri::generate_handler![
            network::network_start_master,
            network::network_stop_master,
            network::network_send_to_worker,
            network::network_broadcast,
            network::network_local_ip,
            network::network_default_port,
            discovery::network_start_discovery,
            discovery::network_stop_discovery,
        ]);

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

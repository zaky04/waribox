// Point d'entrée partagé desktop + mobile — main.rs (desktop) et la coquille
// Android générée par `tauri android init` appellent tous les deux run().
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}

// Coquille minimale : tout le frontend vient de apps/web, servi via devUrl en
// dev et frontendDist (le build Vite) en production — voir tauri.conf.json.
// La logique d'app vit dans lib.rs, partagée avec la cible Android.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gestion_boutique_desktop_lib::run();
}

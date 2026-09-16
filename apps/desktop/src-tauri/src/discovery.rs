// Découverte du Master par mDNS, côté Worker — voir CLAUDE.md, mode réseau
// Phase 1b. Uniquement utile dans un contexte Tauri (desktop-worker ou
// Android) : une PWA ne peut pas parcourir le mDNS depuis du JS, elle
// s'appuie uniquement sur le balayage réseau
// (`apps/web/src/features/network/lanScan.ts`) — c'est au JS de ne proposer
// cette voie que lorsqu'elle est pertinente.
//
// Comme `network.rs` côté Master, ce module ne fait QUE relayer les
// résolutions mDNS au frontend : c'est toujours le handshake hello/helloAck
// existant (voir `useWorkerConnection.connect`) qui valide un candidat
// trouvé ici, jamais la seule présence sur le réseau.
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

const SERVICE_TYPE: &str = "_waribox._tcp.local.";

#[derive(Default)]
pub struct DiscoveryState {
    daemon: Mutex<Option<ServiceDaemon>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
enum DiscoveryEvent {
    #[serde(rename = "found")]
    Found { master_id: String, host: String, port: u16 },
    #[serde(rename = "lost")]
    Lost { master_id: String },
}

/// Démarre la recherche du Master identifié par `target_master_id` (jamais
/// "un Master WariBox quelconque" — voir le commentaire de tête). Idempotent :
/// un second appel pendant qu'une recherche est déjà en cours ne fait rien.
#[tauri::command]
pub async fn network_start_discovery(
    app: AppHandle,
    state: State<'_, DiscoveryState>,
    target_master_id: String,
) -> Result<(), String> {
    let mut guard = state.daemon.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
    *guard = Some(daemon);
    drop(guard);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = receiver.recv_async().await {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let Some(master_id) = info.get_property_val_str("masterId") else {
                        continue;
                    };
                    if master_id != target_master_id {
                        continue;
                    }
                    let Some(addr) = info.get_addresses_v4().into_iter().next() else {
                        continue;
                    };
                    let _ = app_handle.emit(
                        "network:discovery-event",
                        DiscoveryEvent::Found {
                            master_id: master_id.to_string(),
                            host: addr.to_string(),
                            port: info.get_port(),
                        },
                    );
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    if fullname.starts_with(&format!("{target_master_id}.")) {
                        let _ = app_handle.emit(
                            "network:discovery-event",
                            DiscoveryEvent::Lost {
                                master_id: target_master_id.clone(),
                            },
                        );
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Arrête la recherche en cours. Idempotent.
#[tauri::command]
pub async fn network_stop_discovery(state: State<'_, DiscoveryState>) -> Result<(), String> {
    let mut guard = state.daemon.lock().await;
    if let Some(daemon) = guard.take() {
        let _ = daemon.stop_browse(SERVICE_TYPE);
        let _ = daemon.shutdown();
    }
    Ok(())
}

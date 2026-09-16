// Serveur WebSocket du Master, mode réseau local — voir CLAUDE.md, section
// mode réseau. Écoute en clair (ws://, pas de TLS : un Worker JS/WebView ne
// peut pas épingler un certificat auto-signé comme le ferait un client
// natif) sur le réseau local, protégé par un jeton de pairage applicatif
// vérifié sur le tout premier message (hello) de chaque connexion.
//
// Ce module ne fait QUE de la plomberie réseau (accepter les connexions,
// vérifier le jeton, relayer les trames JSON telles quelles au frontend via
// des événements Tauri, écrire les trames que le frontend demande d'envoyer)
// — aucune donnée métier (vente, stock, catalogue) n'est interprétée ici,
// exactement comme le protocole applicatif (WsMessage) défini côté TypeScript
// dans @gestion-boutique/network.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// Port par défaut du serveur Master — fixe (pas choisi par l'OS) pour que
/// le balayage réseau côté Worker (voir `apps/web/src/features/network/lanScan.ts`)
/// sache sur quel port sonder chaque adresse. Source de vérité unique, lue
/// par le JS via `network_default_port` plutôt que dupliquée en dur.
pub const DEFAULT_MASTER_PORT: u16 = 51823;

/// Type de service mDNS annoncé par le Master / recherché par le Worker
/// (voir aussi `discovery.rs`, côté Worker).
const SERVICE_TYPE: &str = "_waribox._tcp.local.";

type ConnectionId = String;

struct Connection {
    sender: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
struct Inner {
    running: bool,
    token: String,
    port: u16,
    connections: HashMap<ConnectionId, Connection>,
    next_id: u64,
    shutdown: Option<mpsc::UnboundedSender<()>>,
    mdns: Option<ServiceDaemon>,
    mdns_fullname: Option<String>,
}

/// Annonce ce Master par mDNS (best-effort : un échec ici — pas d'interface
/// réseau exploitable, daemon indisponible — n'empêche jamais le serveur
/// WebSocket de démarrer, le QR reste toujours la voie de secours). Testé en
/// conditions réelles (annonce + résolution sur l'interface Wi-Fi réelle de
/// la machine de développement) avant d'être intégré ici — voir CLAUDE.md.
fn register_mdns(master_id: &str, master_name: &str, port: u16) -> Option<(ServiceDaemon, String)> {
    let ip = local_ip_address::local_ip().ok()?;
    let daemon = ServiceDaemon::new().ok()?;
    let host_name = format!("{master_id}.local.");
    // `masterId` dupliqué en propriété TXT (pas seulement dans le nom
    // d'instance) : le Worker qui recherche un Master précis (voir
    // discovery.rs) le compare directement, plus robuste qu'un parsing du
    // nom complet.
    let props: Vec<(&str, &str)> = vec![("name", master_name), ("masterId", master_id)];
    let service_info = ServiceInfo::new(SERVICE_TYPE, master_id, &host_name, ip, port, &props[..]).ok()?;
    let fullname = service_info.get_fullname().to_string();
    daemon.register(service_info).ok()?;
    Some((daemon, fullname))
}

#[derive(Default)]
pub struct MasterServerState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
enum MasterEvent {
    #[serde(rename = "connected")]
    Connected { connection_id: String },
    #[serde(rename = "message")]
    Message { connection_id: String, raw: String },
    #[serde(rename = "disconnected")]
    Disconnected { connection_id: String },
}

#[derive(Deserialize)]
struct HelloEnvelope {
    #[serde(rename = "type")]
    kind: String,
    payload: Option<HelloPayload>,
}

#[derive(Deserialize)]
struct HelloPayload {
    token: Option<String>,
}

fn is_valid_hello(raw: &str, expected_token: &str) -> bool {
    let Ok(envelope) = serde_json::from_str::<HelloEnvelope>(raw) else {
        return false;
    };
    if envelope.kind != "hello" {
        return false;
    }
    envelope.payload.and_then(|p| p.token).as_deref() == Some(expected_token)
}

/// Démarre le serveur Master. Idempotent : si déjà démarré, renvoie le port
/// déjà lié sans rien recréer (même convention que
/// `MasterWebSocketServer.start` côté Fougag).
#[tauri::command]
pub async fn network_start_master(
    app: AppHandle,
    state: State<'_, MasterServerState>,
    port: u16,
    token: String,
    master_id: String,
    master_name: String,
) -> Result<u16, String> {
    {
        let inner = state.inner.lock().await;
        if inner.running {
            return Ok(inner.port);
        }
    }

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| e.to_string())?;
    let bound_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let mdns = register_mdns(&master_id, &master_name, bound_port);

    {
        let mut inner = state.inner.lock().await;
        inner.running = true;
        inner.token = token.clone();
        inner.port = bound_port;
        inner.shutdown = Some(shutdown_tx);
        inner.connections.clear();
        inner.next_id = 0;
        if let Some((daemon, fullname)) = mdns {
            inner.mdns = Some(daemon);
            inner.mdns_fullname = Some(fullname);
        }
    }

    let state_arc = state.inner.clone();
    let app_handle = app.clone();
    let expected_token = token;

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, addr)) => {
                            let state_arc = state_arc.clone();
                            let app_handle = app_handle.clone();
                            let expected_token = expected_token.clone();
                            tauri::async_runtime::spawn(async move {
                                handle_connection(stream, addr, state_arc, app_handle, expected_token).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    Ok(bound_port)
}

async fn handle_connection(
    stream: TcpStream,
    _addr: SocketAddr,
    state_arc: Arc<Mutex<Inner>>,
    app_handle: AppHandle,
    expected_token: String,
) {
    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
        Ok(s) => s,
        Err(_) => return,
    };

    let (mut write, mut read) = ws_stream.split();

    let connection_id = {
        let mut inner = state_arc.lock().await;
        inner.next_id += 1;
        format!("conn-{}", inner.next_id)
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut inner = state_arc.lock().await;
        inner
            .connections
            .insert(connection_id.clone(), Connection { sender: tx });
    }

    // Un seul writer par connexion : évite un accès concurrent au Sink
    // WebSocket (qui n'est pas conçu pour être écrit depuis plusieurs
    // endroits à la fois).
    let writer_task = tauri::async_runtime::spawn(async move {
        while let Some(text) = rx.recv().await {
            if write.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let mut authenticated = false;

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        let Message::Text(text) = msg else { continue };

        if !authenticated {
            // Le tout premier message doit être un hello valide portant le
            // bon jeton — sinon la connexion est fermée sans qu'aucun
            // événement applicatif ne soit émis au frontend (voir CLAUDE.md,
            // sécurité réseau local : c'est ce jeton, pas un certificat
            // TLS, qui protège la connexion).
            if !is_valid_hello(&text, &expected_token) {
                break;
            }
            authenticated = true;
            let _ = app_handle.emit(
                "network:master-event",
                MasterEvent::Connected {
                    connection_id: connection_id.clone(),
                },
            );
        }

        let _ = app_handle.emit(
            "network:master-event",
            MasterEvent::Message {
                connection_id: connection_id.clone(),
                raw: text,
            },
        );
    }

    {
        let mut inner = state_arc.lock().await;
        inner.connections.remove(&connection_id);
    }
    writer_task.abort();

    if authenticated {
        let _ = app_handle.emit(
            "network:master-event",
            MasterEvent::Disconnected { connection_id },
        );
    }
}

/// Arrête le serveur : ferme l'écoute et toutes les connexions actives.
/// Idempotent.
#[tauri::command]
pub async fn network_stop_master(state: State<'_, MasterServerState>) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if let Some(shutdown) = inner.shutdown.take() {
        let _ = shutdown.send(());
    }
    inner.running = false;
    inner.connections.clear();
    if let Some(daemon) = inner.mdns.take() {
        if let Some(fullname) = inner.mdns_fullname.take() {
            let _ = daemon.unregister(&fullname);
        }
        let _ = daemon.shutdown();
    }
    Ok(())
}

/// Port par défaut sur lequel le Master écoute — voir [DEFAULT_MASTER_PORT].
/// Source de vérité unique lue par le JS plutôt que dupliquée en dur.
#[tauri::command]
pub fn network_default_port() -> u16 {
    DEFAULT_MASTER_PORT
}

/// Envoie une trame déjà encodée (JSON) à une connexion précise. Renvoie
/// `false` si cette connexion n'existe plus (déjà déconnectée) plutôt que de
/// lever une erreur — un envoi à une connexion qui vient de partir n'est pas
/// une faute de programmation côté appelant.
#[tauri::command]
pub async fn network_send_to_worker(
    state: State<'_, MasterServerState>,
    connection_id: String,
    raw: String,
) -> Result<bool, String> {
    let inner = state.inner.lock().await;
    match inner.connections.get(&connection_id) {
        Some(conn) => Ok(conn.sender.send(raw).is_ok()),
        None => Ok(false),
    }
}

/// Diffuse une trame déjà encodée (JSON) à tous les Workers connectés.
#[tauri::command]
pub async fn network_broadcast(state: State<'_, MasterServerState>, raw: String) -> Result<(), String> {
    let inner = state.inner.lock().await;
    for conn in inner.connections.values() {
        let _ = conn.sender.send(raw.clone());
    }
    Ok(())
}

/// Adresse IPv4 locale de cet appareil sur le réseau local — utilisée pour
/// préremplir le `host` du QR de pairage affiché par le Master.
#[tauri::command]
pub fn network_local_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| e.to_string())
}

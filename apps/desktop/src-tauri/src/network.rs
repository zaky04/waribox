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
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// Port par défaut du serveur Master — fixe (pas choisi par l'OS) pour que
/// le balayage réseau côté Worker (voir `apps/web/src/features/network/lanScan.ts`)
/// sache sur quel port sonder chaque adresse. Source de vérité unique, lue
/// par le JS via `network_default_port` plutôt que dupliquée en dur.
pub const DEFAULT_MASTER_PORT: u16 = 51823;

/// Type de service mDNS annoncé par le Master / recherché par le Worker
/// (voir aussi `discovery.rs`, côté Worker).
const SERVICE_TYPE: &str = "_waribox._tcp.local.";

// Limites contre un appareil malveillant (ou simplement bogué) sur le réseau
// local : le port est ouvert à tout le Wi-Fi, le jeton n'est vérifié qu'au premier
// message. Sans ces garde-fous, des connexions « muettes » ou énormes suffisaient
// à épuiser le Maître.
/// Connexions simultanées maximum (authentifiées ou en cours de poignée de main).
const MAX_CONNECTIONS: usize = 32;
/// Délai pour envoyer un `hello` valide après l'ouverture de la connexion.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Taille maximale du premier message (le `hello`) : il ne contient que quelques champs.
const MAX_HELLO_BYTES: usize = 4096;
/// Taille maximale d'un message et d'une trame, une fois authentifié (un événement de vente reste très en dessous).
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
/// Après ce nombre d'échecs de poignée de main depuis une même adresse, on l'écarte un moment.
const BAN_AFTER_FAILURES: u32 = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const BAN_DURATION: Duration = Duration::from_secs(60);

type ConnectionId = String;

struct FailureRecord {
    count: u32,
    window_start: Instant,
    banned_until: Option<Instant>,
}

/// Suivi des poignées de main ratées par adresse IP (mauvais jeton, silence, message
/// énorme). Pur, sans horloge cachée : l'instant est fourni par l'appelant (testable).
#[derive(Default)]
struct HelloFailures {
    by_ip: HashMap<IpAddr, FailureRecord>,
}

impl HelloFailures {
    fn is_banned(&self, ip: IpAddr, now: Instant) -> bool {
        self.by_ip
            .get(&ip)
            .and_then(|r| r.banned_until)
            .map_or(false, |until| until > now)
    }

    fn register_failure(&mut self, ip: IpAddr, now: Instant) {
        // Ménage : on oublie les adresses dont ni la fenêtre ni le bannissement ne sont actifs.
        self.by_ip.retain(|_, r| {
            r.banned_until.map_or(false, |u| u > now) || now.duration_since(r.window_start) < FAILURE_WINDOW
        });
        let record = self.by_ip.entry(ip).or_insert(FailureRecord {
            count: 0,
            window_start: now,
            banned_until: None,
        });
        if now.duration_since(record.window_start) >= FAILURE_WINDOW {
            record.count = 0;
            record.window_start = now;
        }
        record.count += 1;
        if record.count >= BAN_AFTER_FAILURES {
            record.banned_until = Some(now + BAN_DURATION);
        }
    }

    fn register_success(&mut self, ip: IpAddr) {
        self.by_ip.remove(&ip);
    }
}

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
    failures: HelloFailures,
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

// Comparaison en temps constant : ne révèle pas, par la durée de réponse, combien
// de caractères d'un jeton deviné sont corrects.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_valid_hello(raw: &str, expected_token: &str) -> bool {
    let Ok(envelope) = serde_json::from_str::<HelloEnvelope>(raw) else {
        return false;
    };
    if envelope.kind != "hello" {
        return false;
    }
    match envelope.payload.and_then(|p| p.token) {
        Some(token) => constant_time_eq(token.as_bytes(), expected_token.as_bytes()),
        None => false,
    }
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
        inner.failures = HelloFailures::default();
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
                            // Refus immédiat (avant toute poignée de main) d'une adresse écartée
                            // ou quand le Maître est déjà plein.
                            {
                                let inner = state_arc.lock().await;
                                if inner.connections.len() >= MAX_CONNECTIONS
                                    || inner.failures.is_banned(addr.ip(), Instant::now())
                                {
                                    drop(stream);
                                    continue;
                                }
                            }
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
    addr: SocketAddr,
    state_arc: Arc<Mutex<Inner>>,
    app_handle: AppHandle,
    expected_token: String,
) {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    };
    // La poignée de main HTTP/WebSocket elle-même a un délai : une connexion TCP qui
    // ne dit rien ne doit pas occuper une place indéfiniment.
    let ws_stream = match tokio::time::timeout(
        HELLO_TIMEOUT,
        tokio_tungstenite::accept_async_with_config(stream, Some(config)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        _ => {
            state_arc.lock().await.failures.register_failure(addr.ip(), Instant::now());
            return;
        }
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

    loop {
        // Tant que le `hello` n'est pas arrivé, on n'attend que HELLO_TIMEOUT.
        let next = if authenticated {
            read.next().await
        } else {
            match tokio::time::timeout(HELLO_TIMEOUT, read.next()).await {
                Ok(next) => next,
                Err(_) => {
                    state_arc.lock().await.failures.register_failure(addr.ip(), Instant::now());
                    break;
                }
            }
        };
        let Some(msg) = next else { break };
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
            if text.len() > MAX_HELLO_BYTES || !is_valid_hello(&text, &expected_token) {
                state_arc.lock().await.failures.register_failure(addr.ip(), Instant::now());
                break;
            }
            state_arc.lock().await.failures.register_success(addr.ip());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::from([192, 168, 1, last])
    }

    #[test]
    fn token_comparison_is_exact() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc123", b"abc12"));
        assert!(!constant_time_eq(b"", b"a"));
    }

    #[test]
    fn hello_needs_the_right_token_and_type() {
        let ok = r#"{"type":"hello","payload":{"token":"secret"}}"#;
        assert!(is_valid_hello(ok, "secret"));
        assert!(!is_valid_hello(ok, "autre"));
        assert!(!is_valid_hello(r#"{"type":"sync","payload":{"token":"secret"}}"#, "secret"));
        assert!(!is_valid_hello(r#"{"type":"hello","payload":{}}"#, "secret"));
        assert!(!is_valid_hello(r#"{"type":"hello"}"#, "secret"));
        assert!(!is_valid_hello("pas du json", "secret"));
        assert!(!is_valid_hello("", "secret"));
    }

    #[test]
    fn address_is_banned_after_repeated_failures_then_released() {
        let mut f = HelloFailures::default();
        let t0 = Instant::now();
        for i in 0..(BAN_AFTER_FAILURES - 1) {
            f.register_failure(ip(7), t0 + Duration::from_secs(i as u64));
            assert!(!f.is_banned(ip(7), t0 + Duration::from_secs(i as u64)));
        }
        f.register_failure(ip(7), t0 + Duration::from_secs(5));
        assert!(f.is_banned(ip(7), t0 + Duration::from_secs(6)));
        // Les autres adresses ne sont pas touchées.
        assert!(!f.is_banned(ip(8), t0 + Duration::from_secs(6)));
        // Le bannissement finit par se lever.
        assert!(!f.is_banned(ip(7), t0 + Duration::from_secs(5) + BAN_DURATION + Duration::from_secs(1)));
    }

    #[test]
    fn failures_outside_the_window_do_not_add_up() {
        let mut f = HelloFailures::default();
        let t0 = Instant::now();
        for i in 0..(BAN_AFTER_FAILURES - 1) {
            f.register_failure(ip(9), t0 + Duration::from_secs(i as u64));
        }
        // Bien plus tard : le compteur est reparti de zéro.
        let later = t0 + FAILURE_WINDOW + Duration::from_secs(30);
        f.register_failure(ip(9), later);
        assert!(!f.is_banned(ip(9), later));
    }

    #[test]
    fn a_successful_hello_clears_the_record() {
        let mut f = HelloFailures::default();
        let t0 = Instant::now();
        for _ in 0..(BAN_AFTER_FAILURES - 1) {
            f.register_failure(ip(3), t0);
        }
        f.register_success(ip(3));
        f.register_failure(ip(3), t0);
        assert!(!f.is_banned(ip(3), t0));
    }
}

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
const HELLO_TIMEOUT: Duration = if cfg!(test) { Duration::from_millis(800) } else { Duration::from_secs(10) };
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

/// Où vont les événements du serveur : l'application (événement Tauri) en production,
/// une liste en mémoire dans les tests — le serveur lui-même ne dépend pas de Tauri.
type EventSink = Arc<dyn Fn(MasterEvent) + Send + Sync + 'static>;

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
    let emit: EventSink = Arc::new(move |event| {
        let _ = app.emit("network:master-event", event);
    });
    let (bound_port, started) = start_server(state.inner.clone(), port, token, emit).await?;
    if started {
        if let Some((daemon, fullname)) = register_mdns(&master_id, &master_name, bound_port) {
            let mut inner = state.inner.lock().await;
            inner.mdns = Some(daemon);
            inner.mdns_fullname = Some(fullname);
        }
    }
    Ok(bound_port)
}

/// Lie le port et lance la boucle d'acceptation. Renvoie (port, démarré maintenant ?) :
/// `false` si le serveur tournait déjà (idempotent).
async fn start_server(
    state_arc: Arc<Mutex<Inner>>,
    port: u16,
    token: String,
    emit: EventSink,
) -> Result<(u16, bool), String> {
    {
        let inner = state_arc.lock().await;
        if inner.running {
            return Ok((inner.port, false));
        }
    }

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| e.to_string())?;
    let bound_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();

    {
        let mut inner = state_arc.lock().await;
        inner.running = true;
        inner.token = token.clone();
        inner.port = bound_port;
        inner.shutdown = Some(shutdown_tx);
        inner.connections.clear();
        inner.failures = HelloFailures::default();
        inner.next_id = 0;
    }

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
                            let emit = emit.clone();
                            let expected_token = expected_token.clone();
                            tauri::async_runtime::spawn(async move {
                                handle_connection(stream, addr, state_arc, emit, expected_token).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    Ok((bound_port, true))
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    state_arc: Arc<Mutex<Inner>>,
    emit: EventSink,
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
    let mut writer_task = tauri::async_runtime::spawn(async move {
        while let Some(text) = rx.recv().await {
            if write.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let mut authenticated = false;

    // Résultat d'une attente : un message (ou la fin du flux), le délai du `hello` dépassé,
    // ou l'arrêt du serveur.
    enum Wait {
        Frame(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
        HelloTimedOut,
        ServerStopped,
    }

    loop {
        // Tant que le `hello` n'est pas arrivé, on n'attend que HELLO_TIMEOUT. Quand le
        // serveur s'arrête, `stop_server` vide la table des connexions : l'émetteur de cette
        // connexion disparaît, le writer se termine, et la lecture doit s'arrêter avec lui —
        // sans quoi une connexion déjà authentifiée continuait de relayer ses messages
        // à l'application après l'arrêt du Maître.
        let waited = tokio::select! {
            _ = &mut writer_task => Wait::ServerStopped,
            frame = async {
                if authenticated {
                    Wait::Frame(read.next().await)
                } else {
                    match tokio::time::timeout(HELLO_TIMEOUT, read.next()).await {
                        Ok(next) => Wait::Frame(next),
                        Err(_) => Wait::HelloTimedOut,
                    }
                }
            } => frame,
        };
        let next = match waited {
            Wait::ServerStopped => break,
            Wait::HelloTimedOut => {
                state_arc.lock().await.failures.register_failure(addr.ip(), Instant::now());
                break;
            }
            Wait::Frame(next) => next,
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
            emit(MasterEvent::Connected { connection_id: connection_id.clone(), });
        }

        emit(MasterEvent::Message { connection_id: connection_id.clone(), raw: text, });
    }

    {
        let mut inner = state_arc.lock().await;
        inner.connections.remove(&connection_id);
    }
    writer_task.abort();

    if authenticated {
        emit(MasterEvent::Disconnected { connection_id });
    }
}

/// Arrête le serveur : ferme l'écoute et toutes les connexions actives.
/// Idempotent.
#[tauri::command]
pub async fn network_stop_master(state: State<'_, MasterServerState>) -> Result<(), String> {
    stop_server(&state.inner).await;
    Ok(())
}

async fn stop_server(state_arc: &Arc<Mutex<Inner>>) {
    let mut inner = state_arc.lock().await;
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

// Tests d'intégration du serveur sur de VRAIES connexions TCP/WebSocket (client
// tokio-tungstenite) : jeton, bannissement, délai de poignée de main, taille des
// messages, plafond de connexions, arrêt. Aucun runtime Tauri n'est nécessaire.
#[cfg(test)]
mod integration {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    struct Harness {
        state: Arc<Mutex<Inner>>,
        port: u16,
        seen: Arc<StdMutex<Vec<String>>>,
    }

    fn harness() -> Harness {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let emit: EventSink = Arc::new(move |event| sink.lock().unwrap().push(serde_json::to_string(&event).unwrap()));
        let state = Arc::new(Mutex::new(Inner::default()));
        let (port, started) = tauri::async_runtime::block_on(start_server(state.clone(), 0, TOKEN.to_string(), emit)).expect("demarrage");
        assert!(started);
        Harness { state, port, seen }
    }

    fn url(h: &Harness) -> String {
        format!("ws://127.0.0.1:{}", h.port)
    }

    fn hello(token: &str) -> String {
        format!(r#"{{"type":"hello","payload":{{"token":"{token}","deviceId":"d","deviceName":"n"}},"correlationId":"c"}}"#)
    }

    // Vrai si le serveur ferme (ou coupe) la connexion dans le délai donné.
    async fn closed_within(ws: &mut Client, ms: u64) -> bool {
        loop {
            match tokio::time::timeout(Duration::from_millis(ms), ws.next()).await {
                Err(_) => return false,
                Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => continue,
            }
        }
    }

    #[test]
    fn start_is_idempotent() {
        let h = harness();
        let emit: EventSink = Arc::new(|_| {});
        let (port, started) = tauri::async_runtime::block_on(start_server(h.state.clone(), 0, TOKEN.to_string(), emit)).unwrap();
        assert_eq!(port, h.port);
        assert!(!started, "un second demarrage ne doit pas relancer un serveur");
    }

    #[test]
    fn wrong_token_is_closed_without_event_then_the_address_is_banned() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            for _ in 0..BAN_AFTER_FAILURES {
                let (mut ws, _) = connect_async(url(&h)).await.expect("connexion");
                ws.send(Message::Text(hello("mauvais-jeton"))).await.unwrap();
                assert!(closed_within(&mut ws, 3000).await, "un mauvais jeton doit couper la connexion");
            }
            // Adresse écartée : la connexion est coupée avant même la poignée de main WebSocket.
            assert!(connect_async(url(&h)).await.is_err(), "une adresse bannie ne doit plus pouvoir se connecter");
        });
        assert!(h.seen.lock().unwrap().is_empty(), "aucun evenement ne doit atteindre l'application sans jeton valide");
    }

    #[test]
    fn valid_hello_is_relayed_then_messages_flow_both_ways() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let (mut ws, _) = connect_async(url(&h)).await.unwrap();
            ws.send(Message::Text(hello(TOKEN))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(400)).await;
            {
                let got = h.seen.lock().unwrap();
                assert!(got.iter().any(|e| e.contains("connected")), "evenement connected attendu : {got:?}");
                assert!(got.iter().any(|e| e.contains("message") && e.contains("hello")), "le hello doit etre relaye : {got:?}");
            }
            // Serveur -> client : network_send_to_worker passe par la table des connexions.
            let id = h.state.lock().await.connections.keys().next().cloned().expect("connexion enregistree");
            h.state.lock().await.connections.get(&id).unwrap().sender.send("bonjour".to_string()).unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(2), ws.next()).await.expect("reponse").unwrap().unwrap();
            assert_eq!(reply, Message::Text("bonjour".to_string()));
            // Client -> serveur : un message applicatif est relayé.
            ws.send(Message::Text(r#"{"type":"ping"}"#.to_string())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(h.seen.lock().unwrap().iter().any(|e| e.contains("ping")));
        });
    }

    #[test]
    fn an_oversized_message_closes_the_connection() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let (mut ws, _) = connect_async(url(&h)).await.unwrap();
            ws.send(Message::Text(hello(TOKEN))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            let huge = format!(r#"{{"type":"sync","payload":{{"x":"{}"}}}}"#, "a".repeat(3 * 1024 * 1024));
            let _ = ws.send(Message::Text(huge)).await;
            assert!(closed_within(&mut ws, 5000).await, "un message geant doit couper la connexion");
        });
    }

    #[test]
    fn a_silent_connection_is_dropped_after_the_hello_timeout() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let (mut ws, _) = connect_async(url(&h)).await.unwrap();
            // HELLO_TIMEOUT vaut 800 ms en test : sans hello, le serveur coupe.
            assert!(closed_within(&mut ws, 4000).await, "une connexion muette doit etre coupee");
        });
    }

    #[test]
    fn a_tcp_connection_that_never_speaks_websocket_is_dropped() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let mut raw = TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
            let mut buf = [0u8; 16];
            let closed = tokio::time::timeout(Duration::from_secs(4), tokio::io::AsyncReadExt::read(&mut raw, &mut buf)).await;
            assert!(matches!(closed, Ok(Ok(0)) | Ok(Err(_))), "la connexion TCP muette doit etre coupee par le serveur : {closed:?}");
        });
    }

    #[test]
    fn an_oversized_first_message_is_refused_even_with_the_right_token() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let (mut ws, _) = connect_async(url(&h)).await.unwrap();
            let padded = format!(
                r#"{{"type":"hello","payload":{{"token":"{TOKEN}","pad":"{}"}}}}"#,
                "p".repeat(MAX_HELLO_BYTES + 100)
            );
            ws.send(Message::Text(padded)).await.unwrap();
            assert!(closed_within(&mut ws, 3000).await);
        });
        assert!(h.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn the_server_refuses_connections_beyond_the_cap() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let mut open = Vec::new();
            for _ in 0..MAX_CONNECTIONS {
                let (mut ws, _) = connect_async(url(&h)).await.expect("sous le plafond");
                ws.send(Message::Text(hello(TOKEN))).await.unwrap();
                open.push(ws);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(connect_async(url(&h)).await.is_err(), "la connexion au-dela du plafond doit etre refusee");
            drop(open);
        });
    }

    #[test]
    fn stopping_the_server_refuses_new_connections_and_cuts_existing_ones() {
        let h = harness();
        tauri::async_runtime::block_on(async {
            let (mut ws, _) = connect_async(url(&h)).await.unwrap();
            ws.send(Message::Text(hello(TOKEN))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            stop_server(&h.state).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(connect_async(url(&h)).await.is_err(), "apres l'arret plus aucune connexion ne doit aboutir");
            let before = h.seen.lock().unwrap().len();
            let _ = ws.send(Message::Text(r#"{"type":"sync","payload":{}}"#.to_string())).await;
            let cut = closed_within(&mut ws, 3000).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(cut, "une connexion deja ouverte doit etre coupee a l'arret du serveur");
            assert_eq!(h.seen.lock().unwrap().len(), before, "plus aucun message ne doit etre relaye apres l'arret");
        });
    }
}

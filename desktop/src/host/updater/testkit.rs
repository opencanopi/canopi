//! What the updater's tests drive the real plugin with: an ephemeral minisign key made in the
//! test (the release key never reaches a test, 2.1-Q230), a local HTTP server serving channel
//! files and payloads, and a mock app that registers the plugin with `tauri.conf.json`'s own
//! updater settings and the ephemeral public key.
//!
//! Test code only (the inner attribute below); a module of its own rather than an out-of-line
//! `#[cfg(test)] mod` so the updater's files keep under the file-size limit.
#![cfg(test)]

use base64::Engine as _;
use common_types::update::{
    NetworkFailureKind, UpdateArch, UpdateBundle, UpdateFailure, UpdateFailureCode, UpdateOs,
    UpdateProgress,
};
use ed25519_dalek::{Signer as _, SigningKey};
use std::{
    collections::HashMap,
    hash::{BuildHasher as _, RandomState},
    io::{BufRead as _, BufReader, Write as _},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

use super::{Limits, ProgressSink, UpdaterHost, channel::Installation};

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// A minisign key pair made for one test.
pub struct TestKey {
    signing: SigningKey,
    key_id: [u8; 8],
}

impl TestKey {
    /// A fresh key from the process's random hasher keys.
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        for chunk in seed.chunks_mut(8) {
            chunk.copy_from_slice(&RandomState::new().hash_one(0u8).to_le_bytes());
        }
        let mut key_id = [0u8; 8];
        key_id.copy_from_slice(&RandomState::new().hash_one(1u8).to_le_bytes());
        Self {
            signing: SigningKey::from_bytes(&seed),
            key_id,
        }
    }

    /// The public key as the updater's `pubkey` setting holds it: the base64 of a minisign
    /// public key file.
    pub fn public_key(&self) -> String {
        let mut bin = b"Ed".to_vec();
        bin.extend_from_slice(&self.key_id);
        bin.extend_from_slice(self.signing.verifying_key().as_bytes());
        let file = format!(
            "untrusted comment: minisign public key\n{}\n",
            BASE64.encode(bin)
        );
        BASE64.encode(file)
    }

    /// The signature of `data` signed for `version`, as a channel file carries it: the base64 of
    /// a minisign signature file whose trusted comment names the version, as the Tauri CLI writes.
    pub fn sign(&self, data: &[u8], version: &str) -> String {
        let signature = self.signing.sign(data).to_bytes();
        let trusted = format!("timestamp:0\tfile:payload\tversion:{version}");
        let mut global = signature.to_vec();
        global.extend_from_slice(trusted.as_bytes());
        let global = self.signing.sign(&global).to_bytes();
        let mut bin = b"Ed".to_vec();
        bin.extend_from_slice(&self.key_id);
        bin.extend_from_slice(&signature);
        let file = format!(
            "untrusted comment: signature from a test key\n{}\ntrusted comment: {trusted}\n{}\n",
            BASE64.encode(bin),
            BASE64.encode(global)
        );
        BASE64.encode(file)
    }
}

/// One answer the server gives for a path.
#[derive(Clone)]
pub enum Route {
    /// `200` with this body.
    Body(Vec<u8>),
    /// This status and no body.
    Status(u16),
    /// `302` to this URL.
    Redirect(String),
    /// `200` announcing `total` bytes, sending `sent` of them, then nothing.
    Stall { total: usize, sent: usize },
    /// `200` with this body, sent after this delay.
    Slow(Duration, Vec<u8>),
}

/// A local HTTP/1.1 server; each connection answers one request from the route table.
#[derive(Clone)]
pub struct Server {
    address: SocketAddr,
    routes: Arc<Mutex<HashMap<String, Route>>>,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Server {
    /// A server on a free local port, answering on its own threads until the test process ends.
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = Self {
            address: listener.local_addr().unwrap(),
            routes: Arc::default(),
            hits: Arc::default(),
        };
        let accepting = server.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let answering = accepting.clone();
                std::thread::spawn(move || answering.answer(stream));
            }
        });
        server
    }

    /// The URL of `path` on this server.
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }

    /// Answers `path` with `route` from now on.
    pub fn route(&self, path: &str, route: Route) {
        self.routes.lock().unwrap().insert(path.to_owned(), route);
    }

    /// The paths requested so far, in order.
    pub fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }

    fn answer(&self, mut stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            return;
        }
        let mut header = String::new();
        while reader.read_line(&mut header).is_ok_and(|read| read > 2) {
            header.clear();
        }
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .to_owned();
        self.hits.lock().unwrap().push(path.clone());
        let route = self.routes.lock().unwrap().get(&path).cloned();
        let _ = match route {
            Some(Route::Body(body)) => write_body(&mut stream, &body),
            Some(Route::Slow(delay, body)) => {
                std::thread::sleep(delay);
                write_body(&mut stream, &body)
            }
            Some(Route::Status(status)) => write!(
                stream,
                "HTTP/1.1 {status} Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            ),
            Some(Route::Redirect(location)) => write!(
                stream,
                "HTTP/1.1 302 Found\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            ),
            Some(Route::Stall { total, sent }) => {
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-length: {total}\r\nconnection: close\r\n\r\n"
                );
                let _ = stream.write_all(&vec![0u8; sent]);
                let _ = stream.flush();
                std::thread::sleep(Duration::from_secs(30));
                Ok(())
            }
            None => write!(
                stream,
                "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            ),
        };
    }
}

fn write_body(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

/// A local port nothing listens on: a request there is refused, as when offline.
pub fn closed_port_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{address}/stable.json")
}

/// A static channel file offering `version` to the `key` installer only.
pub fn channel_file(version: &str, key: &str, url: &str, signature: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "version": version,
        "notes": "notes",
        "pub_date": "2026-11-02T00:00:00Z",
        "platforms": { key: { "url": url, "signature": signature } },
    }))
    .unwrap()
}

/// An ELF-looking payload, as an AppImage starts.
pub fn elf_payload(size: usize) -> Vec<u8> {
    let mut payload = b"\x7fELF".to_vec();
    payload.resize(size.max(4), 7);
    payload
}

/// The updater settings `tauri.conf.json` ships, with `pubkey` replaced by a test key's.
pub fn shipped_updater_config(pubkey: &str) -> serde_json::Value {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../../tauri.conf.json"))
        .expect("tauri.conf.json parses");
    let mut updater = config["plugins"]["updater"].clone();
    assert!(updater.is_object(), "tauri.conf.json has plugins.updater");
    updater["pubkey"] = serde_json::Value::String(pubkey.to_owned());
    updater
}

/// A mock app with the updater plugin registered as Canopi registers it, configured with the
/// shipped settings and `pubkey`.
pub fn mock_app(pubkey: &str) -> tauri::App<tauri::test::MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".to_owned(), shipped_updater_config(pubkey));
    tauri::test::mock_builder()
        .plugin(super::plugin())
        .build(context)
        .expect("the mock app builds")
}

/// A Linux AppImage installation.
pub const APPIMAGE: Installation = Installation {
    os: UpdateOs::Linux,
    arch: UpdateArch::X86_64,
    bundle: UpdateBundle::Appimage,
};
/// A Linux `.deb` installation.
pub const DEB: Installation = Installation {
    bundle: UpdateBundle::Deb,
    ..APPIMAGE
};
/// Limits short enough for tests.
pub const FAST: Limits = Limits {
    check_timeout: Duration::from_secs(5),
    connect_timeout: Duration::from_secs(2),
    stall_timeout: Duration::from_secs(1),
    size_cap: 1 << 20,
};

/// A server offering 9.0.0 to `installation` with `payload`, signed by `key` for `signed_as`.
pub struct Offer {
    pub key: TestKey,
    pub server: Server,
    pub payload: Vec<u8>,
}

impl Offer {
    pub fn new(
        installation: Installation,
        payload: Vec<u8>,
        signed: &[u8],
        signed_as: &str,
    ) -> Self {
        let key = TestKey::generate();
        let server = Server::start();
        let signature = key.sign(signed, signed_as);
        server.route(
            "/stable.json",
            Route::Body(channel_file(
                "9.0.0",
                &installation.key(),
                &server.url("/payload"),
                &signature,
            )),
        );
        server.route("/payload", Route::Body(payload.clone()));
        Self {
            key,
            server,
            payload,
        }
    }

    pub fn signed(installation: Installation) -> Self {
        let payload = elf_payload(64 * 1024);
        Self::new(installation, payload.clone(), &payload, "9.0.0")
    }

    pub fn host(&self, installation: Installation, limits: Limits) -> UpdaterHost {
        UpdaterHost::for_test(installation, limits, &self.server.url("/stable.json"))
    }
}

/// Runs `future` to its end on the app runtime.
pub fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// A progress sink and what it heard.
pub fn sink() -> (ProgressSink, Arc<Mutex<Vec<UpdateProgress>>>) {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    let sink: ProgressSink = Arc::new(move |progress| hearing.lock().unwrap().push(progress));
    (sink, heard)
}

/// The failure code of a settlement that must fail.
pub fn code(settled: Result<impl std::fmt::Debug, UpdateFailure>) -> UpdateFailureCode {
    settled.unwrap_err().code
}

/// A network failure code.
pub fn network(kind: NetworkFailureKind) -> UpdateFailureCode {
    UpdateFailureCode::Network { network: kind }
}

/// A fresh folder for one test.
pub fn scratch(name: &str) -> std::path::PathBuf {
    let folder = std::env::temp_dir()
        .join(format!("canopi-updater-{}", std::process::id()))
        .join(format!("{name}-{:?}", std::thread::current().id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

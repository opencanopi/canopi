use canopi_support::durable::{
    OsDurableFs, Precondition, PublishSource, TargetLocks, publish_durably,
};
use canopi_support::hash;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicU64, Ordering},
};
use ureq::http::header::{CONTENT_TYPE, LOCATION};

const IMAGE_FETCH_TIMEOUT_SECS: u64 = 10;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Redirect hops followed by hand, each checked against the host allowlist.
const MAX_IMAGE_REDIRECTS: usize = 5;
/// Wikimedia's user-agent policy asks for an agent that identifies the application.
const IMAGE_USER_AGENT: &str = concat!(
    "Canopi/",
    env!("CARGO_PKG_VERSION"),
    " (+https://projectcanopi.com)"
);
/// Hosts that serve the plant DB's species images: iNaturalist open data, and
/// Wikimedia Commons `Special:FilePath` links, which redirect to the upload host.
const SPECIES_MEDIA_HOSTS: &[&str] = &[
    "inaturalist-open-data.s3.amazonaws.com",
    "commons.wikimedia.org",
    "upload.wikimedia.org",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageCacheError {
    /// The URL is not a species-media URL this cache may fetch.
    DisallowedUrl,
    /// The server answered with something other than a raster image.
    NotAnImage(String),
    Fetch(String),
    Store(String),
}

impl std::fmt::Display for ImageCacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DisallowedUrl => write!(f, "Image URL is not an allowed species-media URL"),
            Self::NotAnImage(content_type) => {
                write!(f, "Image response is not a raster image ({content_type})")
            }
            Self::Fetch(message) | Self::Store(message) => f.write_str(message),
        }
    }
}

/// The HTTPS URL to fetch for a species-media URL. Only the allowlisted hosts
/// on the default port, without credentials, are accepted; the plant DB's
/// `http://` Commons links are fetched over HTTPS, never in plaintext.
fn species_media_url(url: &str) -> Result<String, ImageCacheError> {
    let uri = url
        .parse::<ureq::http::Uri>()
        .map_err(|_| ImageCacheError::DisallowedUrl)?;
    let authority = uri.authority().ok_or(ImageCacheError::DisallowedUrl)?;
    let scheme_allowed = matches!(uri.scheme_str(), Some("https" | "http"));
    let host_allowed = SPECIES_MEDIA_HOSTS
        .iter()
        .any(|host| authority.as_str().eq_ignore_ascii_case(host));
    if !scheme_allowed || !host_allowed {
        return Err(ImageCacheError::DisallowedUrl);
    }
    let path_and_query = uri.path_and_query().map_or("/", |path| path.as_str());
    Ok(format!(
        "https://{}{path_and_query}",
        authority.as_str().to_ascii_lowercase()
    ))
}

/// Resolve a redirect `Location` against the current URL and re-check it.
fn redirect_target(current: &str, location: &str) -> Result<String, ImageCacheError> {
    if location.starts_with('/') && !location.starts_with("//") {
        let uri = current
            .parse::<ureq::http::Uri>()
            .map_err(|_| ImageCacheError::DisallowedUrl)?;
        let authority = uri.authority().ok_or(ImageCacheError::DisallowedUrl)?;
        return species_media_url(&format!("https://{authority}{location}"));
    }
    if !location.starts_with("https://") {
        return Err(ImageCacheError::DisallowedUrl);
    }
    species_media_url(location)
}

/// Raster image types only: an SVG document is never cached or served.
fn is_raster_image(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| value.starts_with("image/") && value != "image/svg+xml")
}

#[derive(Clone)]
pub struct ImageCache {
    cache_dir: PathBuf,
    /// Approximate tracked size — incremented on write, decremented on eviction.
    /// Avoids full directory scans on the hot path.
    tracked_size: Arc<AtomicU64>,
    /// Paths currently being fetched and atomically published.
    in_flight: Arc<(Mutex<HashSet<PathBuf>>, Condvar)>,
    /// Owned per-target lock table for durable image publishing (ADR 0023).
    target_locks: Arc<TargetLocks>,
}

impl ImageCache {
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        let cache_dir = app_data_dir.join("image-cache");
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create image cache dir: {e}"))?;

        // Seed tracked size from disk on startup (one-time scan)
        let initial_size: u64 = fs::read_dir(&cache_dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();

        Ok(Self {
            cache_dir,
            tracked_size: Arc::new(AtomicU64::new(initial_size)),
            in_flight: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
            target_locks: Arc::new(TargetLocks::new()),
        })
    }

    pub fn cached_path(&self, url: &str) -> PathBuf {
        self.cache_dir.join(Self::url_to_filename(url))
    }

    /// Return the cached path of an allowed species-media URL, fetching and
    /// publishing it first on a miss. A hit never reads the file body.
    pub fn fetch_and_cache(&self, url: &str) -> Result<PathBuf, ImageCacheError> {
        let fetch_url = species_media_url(url)?;
        let path = self.cached_path(url);
        if Self::path_is_ready(&path) {
            return Ok(path);
        }

        let _write_guard = self.acquire_in_flight_slot(&path)?;

        if Self::path_is_ready(&path) {
            return Ok(path);
        }

        let bytes = Self::fetch_image(fetch_url)?;

        // The frontend expects a path that exists, so a failed write is surfaced.
        let byte_len = bytes.len() as u64;
        self.write_bytes_atomically(&path, &bytes)
            .map_err(ImageCacheError::Store)?;
        self.tracked_size.fetch_add(byte_len, Ordering::Relaxed);
        self.evict_if_needed();

        Ok(path)
    }

    /// Download one image (10 s timeout, 10 MB cap), following redirects only
    /// to allowlisted hosts.
    fn fetch_image(mut url: String) -> Result<Vec<u8>, ImageCacheError> {
        for _ in 0..=MAX_IMAGE_REDIRECTS {
            let mut response = ureq::get(&url)
                .header("User-Agent", IMAGE_USER_AGENT)
                .config()
                .timeout_global(Some(std::time::Duration::from_secs(
                    IMAGE_FETCH_TIMEOUT_SECS,
                )))
                .https_only(true)
                .max_redirects(0)
                .build()
                .call()
                .map_err(|e| ImageCacheError::Fetch(format!("Failed to fetch image: {e}")))?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        ImageCacheError::Fetch("Image redirect has no location".into())
                    })?;
                url = redirect_target(&url, location)?;
                continue;
            }
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok());
            if !is_raster_image(content_type) {
                return Err(ImageCacheError::NotAnImage(
                    content_type.unwrap_or("no content type").to_owned(),
                ));
            }
            return crate::http::read_limited_bytes(&mut response, MAX_IMAGE_BYTES, "image bytes")
                .map_err(ImageCacheError::Fetch);
        }
        Err(ImageCacheError::Fetch("Too many image redirects".into()))
    }

    fn acquire_in_flight_slot(&self, path: &Path) -> Result<InFlightWriteGuard, ImageCacheError> {
        let poisoned = || ImageCacheError::Store("Image cache lock poisoned".to_string());
        let (lock, cvar) = &*self.in_flight;
        let mut active = lock.lock().map_err(|_| poisoned())?;
        while active.contains(path) {
            active = cvar.wait(active).map_err(|_| poisoned())?;
        }

        if Self::path_is_ready(path) {
            return Ok(InFlightWriteGuard::noop());
        }

        active.insert(path.to_path_buf());
        Ok(InFlightWriteGuard::new(
            self.in_flight.clone(),
            path.to_path_buf(),
        ))
    }

    fn path_is_ready(path: &Path) -> bool {
        match fs::metadata(path) {
            Ok(meta) => meta.is_file() && meta.len() > 0,
            Err(_) => false,
        }
    }

    fn write_bytes_atomically(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        publish_durably(
            &OsDurableFs,
            &self.target_locks,
            PublishSource::Bytes(bytes),
            path,
            "image",
            Precondition::Any,
        )
        .map(|_| ())
        .map_err(|e| format!("Failed to cache image: {e}"))
    }

    /// Convert URL to a safe filename using SHA256 hash prefix + extension.
    fn url_to_filename(url: &str) -> String {
        let hash = hash::sha256_hex(url.as_bytes());

        let url_path = url.split('?').next().unwrap_or(url);
        let ext = url_path
            .rsplit('.')
            .next()
            .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_alphanumeric()))
            .unwrap_or("jpg");

        format!("{}.{}", &hash[..16], ext)
    }

    /// Evict oldest files if cache exceeds 500 MB. Uses tracked size to skip
    /// the directory scan when under limit (the common case).
    fn evict_if_needed(&self) {
        const MAX_BYTES: u64 = 500 * 1024 * 1024;
        let current = self.tracked_size.load(Ordering::Relaxed);
        if current <= MAX_BYTES {
            return;
        }

        let mut entries: Vec<_> = fs::read_dir(&self.cache_dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                let accessed = meta.accessed().or_else(|_| meta.modified()).ok()?;
                Some((e.path(), meta.len(), accessed))
            })
            .collect();

        entries.sort_by_key(|(_, _, t)| *t);

        let mut freed = 0u64;
        let target = current - MAX_BYTES;
        for (path, size, _) in entries {
            if freed >= target {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                freed += size;
            }
        }
        self.tracked_size.fetch_sub(freed, Ordering::Relaxed);
    }
}

struct InFlightWriteGuard {
    state: Option<Arc<(Mutex<HashSet<PathBuf>>, Condvar)>>,
    path: Option<PathBuf>,
}

impl InFlightWriteGuard {
    fn new(state: Arc<(Mutex<HashSet<PathBuf>>, Condvar)>, path: PathBuf) -> Self {
        Self {
            state: Some(state),
            path: Some(path),
        }
    }

    fn noop() -> Self {
        Self {
            state: None,
            path: None,
        }
    }

    #[cfg(test)]
    fn is_noop(&self) -> bool {
        self.state.is_none()
    }
}

impl Drop for InFlightWriteGuard {
    fn drop(&mut self) {
        let Some(state) = self.state.take() else {
            return;
        };
        let Some(path) = self.path.take() else {
            return;
        };

        let (lock, cvar) = &*state;
        if let Ok(mut active) = lock.lock() {
            active.remove(&path);
            cvar.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        IMAGE_USER_AGENT, ImageCache, ImageCacheError, is_raster_image, redirect_target,
        species_media_url,
    };
    use crate::test_scratch::TestScratch;
    use std::fs;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    const INAT_URL: &str =
        "https://inaturalist-open-data.s3.amazonaws.com/photos/300618260/medium.jpeg";

    struct TestDir {
        path: TestScratch,
    }

    impl TestDir {
        fn new() -> Self {
            Self {
                path: TestScratch::new("image-cache"),
            }
        }
    }

    #[test]
    fn cached_path_uses_hashed_filename_and_preserves_extension() {
        let temp_dir = TestDir::new();
        let cache = ImageCache::new(&temp_dir.path).expect("create cache");

        let path = cache.cached_path("https://example.com/photo.webp?size=large");

        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("webp"));
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("stem");
        assert_eq!(name.len(), 16);
    }

    #[test]
    fn only_species_media_hosts_are_fetched_and_always_over_https() {
        assert_eq!(species_media_url(INAT_URL).unwrap(), INAT_URL,);
        assert_eq!(
            species_media_url(
                "http://commons.wikimedia.org/wiki/Special:FilePath/Malus%20domestica.jpg"
            )
            .unwrap(),
            "https://commons.wikimedia.org/wiki/Special:FilePath/Malus%20domestica.jpg",
        );
        for url in [
            "https://example.com/photo.jpg",
            "https://inaturalist-open-data.s3.amazonaws.com.evil.test/photo.jpg",
            "https://user@upload.wikimedia.org/photo.jpg",
            "https://upload.wikimedia.org:8443/photo.jpg",
            "file:///etc/passwd",
            "ftp://upload.wikimedia.org/photo.jpg",
            "http://127.0.0.1:1420/index.html",
            "/relative/photo.jpg",
            "not a url",
        ] {
            assert_eq!(
                species_media_url(url),
                Err(ImageCacheError::DisallowedUrl),
                "{url}"
            );
        }
    }

    #[test]
    fn redirects_are_followed_only_to_species_media_hosts_over_https() {
        let commons = "https://commons.wikimedia.org/wiki/Special:FilePath/Apple.jpg";
        assert_eq!(
            redirect_target(
                commons,
                "https://upload.wikimedia.org/wikipedia/commons/a/ab/Apple.jpg"
            )
            .unwrap(),
            "https://upload.wikimedia.org/wikipedia/commons/a/ab/Apple.jpg",
        );
        assert_eq!(
            redirect_target(commons, "/wiki/File:Apple.jpg").unwrap(),
            "https://commons.wikimedia.org/wiki/File:Apple.jpg",
        );
        for location in [
            "http://upload.wikimedia.org/wikipedia/commons/a/ab/Apple.jpg",
            "https://example.com/Apple.jpg",
            "//example.com/Apple.jpg",
            "relative/Apple.jpg",
        ] {
            assert_eq!(
                redirect_target(commons, location),
                Err(ImageCacheError::DisallowedUrl),
                "{location}"
            );
        }
    }

    #[test]
    fn only_raster_image_responses_are_cached() {
        for content_type in ["image/jpeg", "image/png", "IMAGE/WEBP; charset=binary"] {
            assert!(is_raster_image(Some(content_type)), "{content_type}");
        }
        for content_type in [
            None,
            Some("text/html; charset=utf-8"),
            Some("image/svg+xml"),
            Some("application/octet-stream"),
        ] {
            assert!(!is_raster_image(content_type), "{content_type:?}");
        }
    }

    #[test]
    fn disallowed_url_is_refused_before_any_cache_or_network_access() {
        let temp_dir = TestDir::new();
        let cache = ImageCache::new(&temp_dir.path).expect("create cache");
        let url = "https://example.com/image.jpg";
        // Even a file already sitting under the URL's cache name is not served.
        fs::write(cache.cached_path(url), b"cached-bytes").expect("seed cached image");

        assert_eq!(
            cache.fetch_and_cache(url),
            Err(ImageCacheError::DisallowedUrl)
        );
    }

    #[test]
    fn user_agent_identifies_the_application_version() {
        assert_eq!(
            IMAGE_USER_AGENT,
            format!(
                "Canopi/{} (+https://projectcanopi.com)",
                env!("CARGO_PKG_VERSION")
            )
        );
    }

    #[test]
    fn fetch_and_cache_returns_existing_path_without_requiring_network() {
        let temp_dir = TestDir::new();
        let cache = ImageCache::new(&temp_dir.path).expect("create cache");
        let url = INAT_URL;
        let path = cache.cached_path(url);
        fs::write(&path, b"cached-bytes").expect("seed cached image");

        let resolved = cache
            .fetch_and_cache(url)
            .expect("cache hit should succeed");

        assert_eq!(resolved, path);
    }

    #[test]
    fn write_bytes_atomically_replaces_stale_zero_byte_file() {
        let temp_dir = TestDir::new();
        let cache = ImageCache::new(&temp_dir.path).expect("create cache");
        let path = temp_dir.path.join("stale.jpg");
        fs::write(&path, b"").expect("seed zero-byte cached image");

        cache
            .write_bytes_atomically(&path, b"fresh-bytes")
            .expect("zero-byte cached image should be replaced");

        assert_eq!(fs::read(&path).expect("read cached image"), b"fresh-bytes");
    }

    #[test]
    fn acquire_in_flight_slot_waits_for_existing_writer_and_reuses_published_file() {
        let temp_dir = TestDir::new();
        let cache = ImageCache::new(&temp_dir.path).expect("create cache");
        let url = INAT_URL;
        let path = cache.cached_path(url);
        let barrier = Arc::new(Barrier::new(3));
        let writer_cache = cache.clone();
        let waiter_cache = cache.clone();
        let writer_barrier = Arc::clone(&barrier);
        let waiter_barrier = Arc::clone(&barrier);
        let writer_path = path.clone();
        let waiter_path = path.clone();

        let writer = thread::spawn(move || {
            let write_guard = writer_cache
                .acquire_in_flight_slot(&writer_path)
                .expect("writer should acquire slot");
            writer_barrier.wait();
            thread::sleep(Duration::from_millis(75));
            writer_cache
                .write_bytes_atomically(&writer_path, b"cached-bytes")
                .expect("writer should publish cached bytes");
            drop(write_guard);
        });

        let waiter = thread::spawn(move || {
            waiter_barrier.wait();
            let started = Instant::now();
            let wait_guard = waiter_cache
                .acquire_in_flight_slot(&waiter_path)
                .expect("waiter should return after writer publishes");
            let waited = started.elapsed();
            (wait_guard.is_noop(), waited)
        });

        barrier.wait();
        writer.join().expect("join writer");
        let (noop_guard, waited) = waiter.join().expect("join waiter");

        assert!(
            noop_guard,
            "waiter should reuse the writer's published file"
        );
        assert!(
            waited >= Duration::from_millis(50),
            "waiter should block until the writer publishes the file"
        );
        assert_eq!(fs::read(&path).expect("read cached image"), b"cached-bytes");
    }
}

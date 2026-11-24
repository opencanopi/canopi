//! Content hashing (SHA-256) for file fingerprints and integrity checks (ADR 0023).

use sha2::{Digest as _, Sha256};
use std::io::{self, Read};
use std::path::Path;

/// Lowercase hex SHA-256 digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Lowercase hex SHA-256 digest of a stream, read in chunks so large files are
/// never buffered whole.
pub fn sha256_reader<R: Read>(reader: &mut R) -> io::Result<String> {
    let mut hasher = Sha256::new();
    io::copy(reader, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Lowercase hex SHA-256 digest of the file at `path`, streamed. Returns `Ok(None)`
/// when no file exists at `path`.
pub fn sha256_file(path: &Path) -> io::Result<Option<String>> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    sha256_reader(&mut file).map(Some)
}

#[cfg(test)]
mod tests {
    use super::{sha256_file, sha256_hex, sha256_reader};
    use std::io::Cursor;

    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(sha256_hex(b"abc"), ABC_SHA256);
    }

    #[test]
    fn sha256_reader_streams_bytes() {
        let mut cursor = Cursor::new(b"abc");
        let digest = sha256_reader(&mut cursor).ok();
        assert_eq!(digest.as_deref(), Some(ABC_SHA256));
    }

    #[test]
    fn sha256_file_hashes_existing_and_returns_none_for_missing() {
        let dir = tempfile::tempdir().ok();
        assert!(dir.is_some());
        if let Some(dir) = dir {
            let file = dir.path().join("sample.bin");
            let write_ok = std::fs::write(&file, b"abc").is_ok();
            assert!(write_ok);
            assert_eq!(
                sha256_file(&file).ok().flatten().as_deref(),
                Some(ABC_SHA256)
            );
            assert_eq!(
                sha256_file(&dir.path().join("missing.bin")).ok().flatten(),
                None
            );
        }
    }
}

//! User content typed, not formatted (ADR 0025; plan C18): paths, Design and
//! item names and query text travel as [`Sensitive`] fields of a failure, log
//! event or job message, never inside its text. Display and Debug print the
//! kind's placeholder only, so formatting one into a message, a log line or a
//! problem report never reveals it, and no consent or opt-in does
//! (2.1-Q278); the value is read only through [`Sensitive::expose`], by the
//! code that acts on it (opening the file, or a redacting log layer).

use std::fmt;
use std::path::{Path, PathBuf};

/// A kind of user content and the placeholder it prints as.
pub trait Placeholder {
    /// What Display and Debug print instead of the value.
    const PLACEHOLDER: &'static str;
}

impl Placeholder for PathBuf {
    const PLACEHOLDER: &'static str = canopi_redact::PATH_TOKEN;
}

impl Placeholder for String {
    const PLACEHOLDER: &'static str = canopi_redact::REDACTED_TOKEN;
}

/// User content that prints as its placeholder.
#[derive(Clone, PartialEq, Eq)]
pub struct Sensitive<T: Placeholder>(T);

/// A user's path: prints `<path>`.
pub type UserPath = Sensitive<PathBuf>;

impl<T: Placeholder> Sensitive<T> {
    /// `value` as user content.
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// The value, for the code that acts on it; never for a message.
    pub fn expose(&self) -> &T {
        &self.0
    }
}

impl<T: Placeholder> fmt::Display for Sensitive<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(T::PLACEHOLDER)
    }
}

impl<T: Placeholder> fmt::Debug for Sensitive<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(T::PLACEHOLDER)
    }
}

impl From<&Path> for UserPath {
    fn from(path: &Path) -> Self {
        Self::new(path.to_path_buf())
    }
}

impl From<PathBuf> for UserPath {
    fn from(path: PathBuf) -> Self {
        Self::new(path)
    }
}

#[cfg(test)]
mod tests {
    use super::{Sensitive, UserPath};
    use std::path::{Path, PathBuf};

    /// A report or log event that carries a user path as a field.
    #[derive(Debug)]
    struct ReportLine {
        what: &'static str,
        path: UserPath,
    }

    #[test]
    fn a_user_path_rendered_into_a_report_reads_its_placeholder_never_the_path() {
        for path in [
            r"\\nas\shared\Secret Orchard.canopi",
            "/home/ana/Secret Orchard.canopi",
            r"C:\Users\ana\Secret Orchard.canopi",
        ] {
            let user_path = UserPath::from(Path::new(path));
            let line = ReportLine {
                what: "open failed",
                path: user_path.clone(),
            };
            for rendered in [
                format!("Opening {user_path} failed"),
                format!("{user_path:?}"),
                format!("{line:?}"),
                format!("{line:#?}"),
                format!("{:>40}", user_path),
            ] {
                assert!(rendered.contains("<path>"), "{rendered}");
                assert!(!rendered.contains("Secret"), "{rendered}");
                assert!(!rendered.contains("ana"), "{rendered}");
            }
            // The code that opens the file still reads it.
            assert_eq!(user_path.expose(), &PathBuf::from(path));
            assert_eq!((line.what, line.path), ("open failed", user_path));
        }
    }

    #[test]
    fn other_user_content_reads_the_redaction_token() {
        let name = Sensitive::new("Secret Orchard of Alice".to_owned());
        assert_eq!(format!("Design {name} saved"), "Design <redacted> saved");
        assert_eq!(format!("{name:?}"), "<redacted>");
        assert_eq!(name.expose(), "Secret Orchard of Alice");
    }
}

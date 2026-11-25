//! Branded identifier newtypes shared across Rust and TypeScript (`canopi-f47t.52.218`).
//!
//! Each newtype serialises transparently as a plain JSON string on the wire and is emitted
//! by `bindings-gen` as a branded TypeScript string (`string & { readonly __brand: "..." }`),
//! preventing accidental cross-domain ID swaps at compile time.

use std::fmt;

use serde::{Deserialize, Serialize};
use specta::Type;

macro_rules! branded_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wraps a raw string identifier.
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            /// Borrows the underlying identifier string.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

branded_id!(
    /// Identifier of a Design draft record.
    DraftId
);
branded_id!(
    /// Opaque host-issued grant naming a Design file without exposing its filesystem path (ADR 0027).
    FileGrantId
);
branded_id!(
    /// Compare-and-swap version token of a Design home (SHA-256 hex on files and Desktop Drafts).
    HomeVersion
);
branded_id!(
    /// Identifier of a placed plant in a Design scene.
    PlantId
);
branded_id!(
    /// Identifier of a zone in a Design scene.
    ZoneId
);
branded_id!(
    /// Identifier of a text annotation in a Design scene.
    AnnotationId
);
branded_id!(
    /// Identifier of a scene layer in a Design.
    LayerId
);
branded_id!(
    /// Identifier of an object group in a Design scene.
    GroupId
);
branded_id!(
    /// Identifier of a Data library item.
    LibraryItemId
);
branded_id!(
    /// Identifier of a saved view in a Design.
    SavedViewId
);
branded_id!(
    /// Identifier of a story in a Design.
    StoryId
);
branded_id!(
    /// Identifier of a saved object stamp.
    StampId
);
branded_id!(
    /// Identifier of a Design Notebook section.
    NotebookSectionId
);

/// All branded string type names emitted by `bindings-gen` (including `ids`, `OperationId`, `RedactedText`).
pub const BRANDED_ID_TYPE_NAMES: &[&str] = &[
    "AnnotationId",
    "DraftId",
    "FileGrantId",
    "GroupId",
    "HomeVersion",
    "LayerId",
    "LibraryItemId",
    "NotebookSectionId",
    "PlantId",
    "SavedViewId",
    "StampId",
    "StoryId",
    "ZoneId",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branded_ids_round_trip_as_plain_json_strings() {
        let draft = DraftId::new("draft-42");
        let json = serde_json::to_string(&draft).unwrap();
        assert_eq!(json, "\"draft-42\"");
        let parsed: DraftId = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, draft);
        assert_eq!(parsed.as_str(), "draft-42");
        assert_eq!(parsed.to_string(), "draft-42");
    }
}

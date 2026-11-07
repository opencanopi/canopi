//! Where a `.canopi` refusal points, and what it expected (canopi-cyqd, 2.1-M430).
//!
//! A [`FieldPath`] is built only from schema field names (`&'static str`: the generated
//! schema and the validators' literals), list indices and an anonymous map value, so a
//! refusal never carries a file value: no map key, species name, id or link. It renders
//! as the Web decoder's path (`$.plants[0].position.lat`), with a map value as `[*]`
//! where the Web names the key. A [`Refusal`] pairs it with a content-free expectation;
//! its text is for logs and Problem Reports, never shown (2.1-Q286).

use serde::{Serialize, Serializer};
use specta::Type;
use std::fmt;

/// One step of a [`FieldPath`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldPathSegment {
    /// A schema field name.
    Field(&'static str),
    /// A list index.
    Index(usize),
    /// A map value, whose key is a file value and is never named.
    MapValue,
}

/// The path of a refused value from the Design's root (`$`), rendered as a string on the
/// wire.
#[derive(Debug, Clone, Default, PartialEq, Eq, Type)]
#[specta(type = String)]
pub struct FieldPath {
    segments: Vec<FieldPathSegment>,
}

impl FieldPath {
    /// The Design's root, `$`.
    pub fn root() -> Self {
        Self::default()
    }

    /// This path's field `name`.
    #[must_use]
    pub fn field(&self, name: &'static str) -> Self {
        self.with(FieldPathSegment::Field(name))
    }

    /// This path's list item `index`.
    #[must_use]
    pub fn index(&self, index: usize) -> Self {
        self.with(FieldPathSegment::Index(index))
    }

    /// A value of the map at this path.
    #[must_use]
    pub fn map_value(&self) -> Self {
        self.with(FieldPathSegment::MapValue)
    }

    /// The steps from the root.
    pub fn segments(&self) -> &[FieldPathSegment] {
        &self.segments
    }

    fn with(&self, segment: FieldPathSegment) -> Self {
        let mut segments = Vec::with_capacity(self.segments.len() + 1);
        segments.extend_from_slice(&self.segments);
        segments.push(segment);
        Self { segments }
    }
}

impl fmt::Display for FieldPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("$")?;
        for segment in &self.segments {
            match segment {
                FieldPathSegment::Field(name) => write!(formatter, ".{name}")?,
                FieldPathSegment::Index(index) => write!(formatter, "[{index}]")?,
                FieldPathSegment::MapValue => formatter.write_str("[*]")?,
            }
        }
        Ok(())
    }
}

impl Serialize for FieldPath {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

/// A refused `.canopi` value: where it is and what was expected there, never the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// Where the refused value is.
    pub field_path: FieldPath,
    /// What was expected there, from the schema or a validator's rule.
    pub expected: String,
}

impl Refusal {
    /// A refusal at `field_path` expecting `expected`.
    pub fn new(field_path: FieldPath, expected: impl Into<String>) -> Self {
        Self {
            field_path,
            expected: expected.into(),
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.field_path, self.expected)
    }
}

impl std::error::Error for Refusal {}

#[cfg(test)]
mod tests {
    use super::{FieldPath, Refusal};

    #[test]
    fn a_path_renders_as_the_web_decoder_names_it_with_map_keys_left_out() {
        let root = FieldPath::root();
        assert_eq!(root.to_string(), "$");
        let lat = root.field("plants").index(0).field("position").field("lat");
        assert_eq!(lat.to_string(), "$.plants[0].position.lat");
        assert_eq!(
            root.field("plant_species_colors").map_value().to_string(),
            "$.plant_species_colors[*]"
        );
        assert_eq!(
            serde_json::to_value(&lat).expect("a path serializes"),
            serde_json::json!("$.plants[0].position.lat")
        );
    }

    #[test]
    fn a_refusal_reads_as_its_path_then_its_expectation() {
        let refusal = Refusal::new(FieldPath::root().field("version"), "expected an integer");
        assert_eq!(refusal.to_string(), "$.version: expected an integer");
    }
}

//! Shapes and rules of the analysis registry (ADR 0011).
//!
//! `common-types/analysis-registry.json` is the authored contract: what each
//! analysis is (id, recipe version, inputs, typed parameters in metres, m² and
//! degrees, outputs, lane). `bindings-gen` validates it and generates a static
//! [`AnalysisDefinition`] table for the desktop crate and a typed const array
//! for the frontend. How an analysis runs stays in handwritten executors.
//!
//! The parameter and output rules here are pure, so the native command and the
//! tests share one authority; checks that need the library (input items, grid
//! facts, the engine) live beside the catalogue.

use crate::library::{AnalysisParamValue, LibraryItemType, ParamValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum AnalysisGroup {
    Terrain,
}

/// Where an analysis runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum AnalysisLane {
    /// The pinned GeoLibre CLI, one 1024² core window plus `halo` cells at a
    /// time.
    GeolibreWindowed { halo: u32 },
}

/// A property of the input grid an analysis needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridRequirement {
    /// A projected CRS with metre horizontal units.
    ProjectedMetreGrid,
    /// Sample values in metres.
    MetreValues,
}

/// The unit a number parameter is entered in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum ParamUnit {
    Metre,
    SquareMetre,
    Degree,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum AnalysisParamKind {
    Choice {
        options: &'static [&'static str],
    },
    Number {
        min: f64,
        max: f64,
        step: f64,
        unit: ParamUnit,
    },
    Integer {
        min: i32,
        max: i32,
    },
    Boolean,
}

/// A parameter's default. `Required` means the user must choose.
#[derive(Debug, Clone, Copy, PartialEq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum ParamDefault {
    Required,
    Choice(&'static str),
    Number(f64),
    Integer(i32),
    Boolean(bool),
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisParamSpec {
    pub key: &'static str,
    pub kind: AnalysisParamKind,
    pub default: ParamDefault,
    /// Shown in a disclosure.
    pub advanced: bool,
    /// Shown only while the named choice parameter holds the value.
    pub visible_when: Option<(&'static str, &'static str)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisInputSpec {
    pub key: &'static str,
    pub accepts: &'static [LibraryItemType],
    pub requires: &'static [GridRequirement],
}

/// The unit label an output's values carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum OutputUnits {
    Fixed(&'static str),
    /// Chosen by a choice parameter: `(option, unit)` pairs.
    ByParam {
        param: &'static str,
        map: &'static [(&'static str, &'static str)],
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisOutputSpec {
    pub key: &'static str,
    pub item: LibraryItemType,
    pub units: OutputUnits,
    /// Whether the user may leave this output out.
    pub optional: bool,
    pub default_selected: bool,
    /// `false` for outputs kept only for provenance or other analyses.
    pub presentable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisDefinition {
    /// Stable id, e.g. `terrain.slope`.
    pub id: &'static str,
    /// Recipe version; bumped when the method changes.
    pub version: u32,
    pub group: AnalysisGroup,
    pub lane: AnalysisLane,
    pub inputs: &'static [AnalysisInputSpec],
    pub params: &'static [AnalysisParamSpec],
    pub outputs: &'static [AnalysisOutputSpec],
}

impl AnalysisDefinition {
    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub fn param(&self, key: &str) -> Option<&'static AnalysisParamSpec> {
        self.params.iter().find(|param| param.key == key)
    }

    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub fn output(&self, key: &str) -> Option<&'static AnalysisOutputSpec> {
        self.outputs.iter().find(|output| output.key == key)
    }
}

/// The complete, typed parameter list of a request: every registered
/// parameter in registry order, defaults filled in.
///
/// Unknown keys, duplicates, wrong types, values out of range or step, unknown
/// choices and a missing required parameter are refused by name. Stored
/// parameters of a definition are revalidated the same way before a rerun, so
/// settings a newer recipe no longer accepts are never run.
pub fn resolve_parameters(
    definition: &AnalysisDefinition,
    given: &[AnalysisParamValue],
) -> Result<Vec<AnalysisParamValue>, String> {
    for (index, value) in given.iter().enumerate() {
        if definition.param(&value.key).is_none() {
            return Err(format!(
                "{} has no parameter '{}'",
                definition.id, value.key
            ));
        }
        if given[..index]
            .iter()
            .any(|earlier| earlier.key == value.key)
        {
            return Err(format!("parameter '{}' is given twice", value.key));
        }
    }
    definition
        .params
        .iter()
        .map(|spec| {
            let value = match given.iter().find(|value| value.key == spec.key) {
                Some(value) => value.value.clone(),
                None => default_value(spec).ok_or_else(|| {
                    format!("choose a value for '{}' of {}", spec.key, definition.id)
                })?,
            };
            check_value(spec, &value)?;
            Ok(AnalysisParamValue {
                key: spec.key.to_string(),
                value,
            })
        })
        .collect()
}

fn default_value(spec: &AnalysisParamSpec) -> Option<ParamValue> {
    match spec.default {
        ParamDefault::Required => None,
        ParamDefault::Choice(option) => Some(ParamValue::Choice(option.to_string())),
        ParamDefault::Number(value) => Some(ParamValue::Number(value)),
        ParamDefault::Integer(value) => Some(ParamValue::Integer(value)),
        ParamDefault::Boolean(value) => Some(ParamValue::Boolean(value)),
    }
}

fn check_value(spec: &AnalysisParamSpec, value: &ParamValue) -> Result<(), String> {
    let key = spec.key;
    match (spec.kind, value) {
        (AnalysisParamKind::Choice { options }, ParamValue::Choice(choice)) => {
            if options.contains(&choice.as_str()) {
                Ok(())
            } else {
                Err(format!(
                    "'{choice}' is not an option of '{key}' ({})",
                    options.join(", ")
                ))
            }
        }
        (AnalysisParamKind::Number { min, max, step, .. }, ParamValue::Number(number)) => {
            if !number.is_finite() || *number < min || *number > max {
                return Err(format!("'{key}' must be between {min} and {max}"));
            }
            let steps = (number - min) / step;
            if (steps - steps.round()).abs() > 1e-9 {
                return Err(format!("'{key}' must be a multiple of {step} from {min}"));
            }
            Ok(())
        }
        (AnalysisParamKind::Integer { min, max }, ParamValue::Integer(integer)) => {
            if *integer < min || *integer > max {
                Err(format!("'{key}' must be between {min} and {max}"))
            } else {
                Ok(())
            }
        }
        (AnalysisParamKind::Boolean, ParamValue::Boolean(_)) => Ok(()),
        (_, _) => Err(format!("'{key}' has the wrong type of value")),
    }
}

/// The outputs a request produces, in registry order: the selected optional
/// outputs and every required one. An unknown key or an empty selection is
/// refused by name.
pub fn resolve_outputs(
    definition: &AnalysisDefinition,
    selected: &[String],
) -> Result<Vec<&'static AnalysisOutputSpec>, String> {
    if let Some(unknown) = selected.iter().find(|key| definition.output(key).is_none()) {
        return Err(format!("{} has no output '{unknown}'", definition.id));
    }
    let outputs: Vec<&'static AnalysisOutputSpec> = definition
        .outputs
        .iter()
        .filter(|output| !output.optional || selected.iter().any(|key| key == output.key))
        .collect();
    if outputs.is_empty() {
        return Err("choose at least one result to produce".to_string());
    }
    Ok(outputs)
}

/// The unit label of one output under resolved parameters.
pub fn output_units(
    output: &AnalysisOutputSpec,
    parameters: &[AnalysisParamValue],
) -> Result<String, String> {
    match output.units {
        OutputUnits::Fixed(units) => Ok(units.to_string()),
        OutputUnits::ByParam { param, map } => {
            let chosen = parameters
                .iter()
                .find(|value| value.key == param)
                .and_then(|value| match &value.value {
                    ParamValue::Choice(choice) => Some(choice.as_str()),
                    _ => None,
                })
                .ok_or_else(|| format!("the units of '{}' need '{param}'", output.key))?;
            map.iter()
                .find(|(option, _)| *option == chosen)
                .map(|(_, units)| (*units).to_string())
                .ok_or_else(|| format!("'{chosen}' names no unit for '{}'", output.key))
        }
    }
}

/// The choice a resolved parameter list holds for `key`.
pub fn choice<'a>(parameters: &'a [AnalysisParamValue], key: &str) -> Option<&'a str> {
    parameters
        .iter()
        .find(|value| value.key == key)
        .and_then(|value| match &value.value {
            ParamValue::Choice(choice) => Some(choice.as_str()),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::RasterQuantity;

    const DEM: LibraryItemType = LibraryItemType::Raster {
        quantity: RasterQuantity::GroundElevation,
    };

    /// A fixture covering every parameter type, independent of the shipped
    /// registry.
    static FIXTURE: AnalysisDefinition = AnalysisDefinition {
        id: "test.everything",
        version: 3,
        group: AnalysisGroup::Terrain,
        lane: AnalysisLane::GeolibreWindowed { halo: 1 },
        inputs: &[AnalysisInputSpec {
            key: "dem",
            accepts: &[DEM],
            requires: &[GridRequirement::ProjectedMetreGrid],
        }],
        params: &[
            AnalysisParamSpec {
                key: "unit",
                kind: AnalysisParamKind::Choice {
                    options: &["degrees", "percent"],
                },
                default: ParamDefault::Required,
                advanced: false,
                visible_when: None,
            },
            AnalysisParamSpec {
                key: "distance",
                kind: AnalysisParamKind::Number {
                    min: 1.0,
                    max: 100.0,
                    step: 0.5,
                    unit: ParamUnit::Metre,
                },
                default: ParamDefault::Number(10.0),
                advanced: true,
                visible_when: Some(("unit", "degrees")),
            },
            AnalysisParamSpec {
                key: "passes",
                kind: AnalysisParamKind::Integer { min: 1, max: 9 },
                default: ParamDefault::Integer(3),
                advanced: false,
                visible_when: None,
            },
            AnalysisParamSpec {
                key: "smooth",
                kind: AnalysisParamKind::Boolean,
                default: ParamDefault::Boolean(false),
                advanced: false,
                visible_when: None,
            },
        ],
        outputs: &[
            AnalysisOutputSpec {
                key: "main",
                item: LibraryItemType::Raster {
                    quantity: RasterQuantity::Slope,
                },
                units: OutputUnits::ByParam {
                    param: "unit",
                    map: &[("degrees", "°"), ("percent", "%")],
                },
                optional: false,
                default_selected: true,
                presentable: true,
            },
            AnalysisOutputSpec {
                key: "extra",
                item: LibraryItemType::Raster {
                    quantity: RasterQuantity::Slope,
                },
                units: OutputUnits::Fixed("m"),
                optional: true,
                default_selected: false,
                presentable: true,
            },
        ],
    };

    fn value(key: &str, value: ParamValue) -> AnalysisParamValue {
        AnalysisParamValue {
            key: key.to_string(),
            value,
        }
    }

    #[test]
    fn defaults_fill_in_and_the_order_is_the_registry_order() {
        let resolved = resolve_parameters(
            &FIXTURE,
            &[value("unit", ParamValue::Choice("percent".into()))],
        )
        .unwrap();
        assert_eq!(
            resolved,
            vec![
                value("unit", ParamValue::Choice("percent".into())),
                value("distance", ParamValue::Number(10.0)),
                value("passes", ParamValue::Integer(3)),
                value("smooth", ParamValue::Boolean(false)),
            ]
        );
    }

    #[test]
    fn parameter_refusals_name_the_problem() {
        let refuse = |given: Vec<AnalysisParamValue>, needle: &str| {
            let error = resolve_parameters(&FIXTURE, &given).unwrap_err();
            assert!(error.contains(needle), "{error} should mention {needle}");
        };
        let unit = || value("unit", ParamValue::Choice("degrees".into()));
        refuse(vec![], "choose a value for 'unit'");
        refuse(
            vec![value("unit", ParamValue::Choice("radians".into()))],
            "not an option",
        );
        refuse(
            vec![unit(), value("colour", ParamValue::Boolean(true))],
            "no parameter 'colour'",
        );
        refuse(vec![unit(), unit()], "given twice");
        refuse(
            vec![unit(), value("distance", ParamValue::Number(0.5))],
            "between 1 and 100",
        );
        refuse(
            vec![unit(), value("distance", ParamValue::Number(f64::NAN))],
            "between",
        );
        refuse(
            vec![unit(), value("distance", ParamValue::Number(1.2))],
            "multiple of 0.5",
        );
        refuse(
            vec![unit(), value("passes", ParamValue::Integer(10))],
            "between 1 and 9",
        );
        refuse(
            vec![unit(), value("smooth", ParamValue::Integer(1))],
            "wrong type",
        );
        resolve_parameters(
            &FIXTURE,
            &[unit(), value("distance", ParamValue::Number(1.5))],
        )
        .expect("a value on the step is accepted");
    }

    #[test]
    fn outputs_resolve_in_registry_order_and_refuse_unknown_keys() {
        let keys = |selected: &[&str]| {
            resolve_outputs(
                &FIXTURE,
                &selected
                    .iter()
                    .map(|key| key.to_string())
                    .collect::<Vec<_>>(),
            )
            .map(|outputs| outputs.iter().map(|output| output.key).collect::<Vec<_>>())
        };
        assert_eq!(keys(&[]).unwrap(), ["main"], "required outputs always run");
        assert_eq!(keys(&["extra"]).unwrap(), ["main", "extra"]);
        assert!(keys(&["nope"]).unwrap_err().contains("no output 'nope'"));
    }

    #[test]
    fn output_units_follow_the_chosen_parameter() {
        let percent = resolve_parameters(
            &FIXTURE,
            &[value("unit", ParamValue::Choice("percent".into()))],
        )
        .unwrap();
        assert_eq!(output_units(&FIXTURE.outputs[0], &percent).unwrap(), "%");
        assert_eq!(output_units(&FIXTURE.outputs[1], &percent).unwrap(), "m");
        assert!(output_units(&FIXTURE.outputs[0], &[]).is_err());
        assert_eq!(choice(&percent, "unit"), Some("percent"));
    }
}

//! PDF scale picker entries and scale-bar nice step ladders
//! (contracts §14, `2.1-Q133`, `2.1-Q356`).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{CONVERSION_CONSTANTS as C, UnitSystem};

/// PDF scale picker group (`2.1-Q133`, `2.1-Q356`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PdfScaleGroup {
    /// Fit the chosen area to the page.
    Fit,
    /// Dimensionless ratio scales (`1:50`..`1:5,000`), offered in both systems.
    Ratio,
    /// US architectural inch-to-foot scales (`1/16″ = 1′-0″`..`1″ = 1′-0″`), US customary only.
    UsArchitectural,
    /// US engineering inch-to-foot scales (`1″ = 10′`..`1″ = 100′`), US customary only.
    UsEngineering,
}

impl PdfScaleGroup {
    /// Stable group key.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fit => "fit",
            Self::Ratio => "ratio",
            Self::UsArchitectural => "us_architectural",
            Self::UsEngineering => "us_engineering",
        }
    }
}

/// One concrete fixed-ratio PDF scale entry (`2.1-Q133`, `2.1-Q356`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdfScaleSpec {
    /// Stable identifier stored in `print_setup`.
    pub id: &'static str,
    /// Picker group (`Ratio`, `UsArchitectural`, or `UsEngineering`).
    pub group: PdfScaleGroup,
    /// Static display label for US architectural/engineering scales (`1/8″ = 1′-0″`, `1″ = 20′`).
    /// `None` for `Ratio` scales, whose `1:<denominator>` label must be formatted via `Intl`.
    pub label: Option<&'static str>,
    /// Exact denominator `D` of the `1 : D` map ratio.
    pub denominator: u32,
    /// Offered when `unit_system == Metric`.
    pub metric: bool,
    /// Offered when `unit_system == UsCustomary`.
    pub us_customary: bool,
}

const fn ratio(id: &'static str, denominator: u32) -> PdfScaleSpec {
    PdfScaleSpec {
        id,
        group: PdfScaleGroup::Ratio,
        label: None,
        denominator,
        metric: true,
        us_customary: true,
    }
}

const fn us_scale(
    id: &'static str,
    group: PdfScaleGroup,
    label: &'static str,
    denominator: u32,
) -> PdfScaleSpec {
    PdfScaleSpec {
        id,
        group,
        label: Some(label),
        denominator,
        metric: false,
        us_customary: true,
    }
}

/// Operator-approved PDF scale picker list (`2.1-Q133`, `2.1-Q356`).
pub const PDF_SCALES: &[PdfScaleSpec] = &[
    ratio("ratio:50", 50),
    ratio("ratio:100", 100),
    ratio("ratio:200", 200),
    ratio("ratio:250", 250),
    ratio("ratio:500", 500),
    ratio("ratio:1000", 1_000),
    ratio("ratio:2000", 2_000),
    ratio("ratio:2500", 2_500),
    ratio("ratio:5000", 5_000),
    us_scale(
        "us_arch:1_16_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/16″ = 1′-0″",
        192,
    ),
    us_scale(
        "us_arch:3_32_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/32″ = 1′-0″",
        128,
    ),
    us_scale(
        "us_arch:1_8_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/8″ = 1′-0″",
        96,
    ),
    us_scale(
        "us_arch:3_16_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/16″ = 1′-0″",
        64,
    ),
    us_scale(
        "us_arch:1_4_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/4″ = 1′-0″",
        48,
    ),
    us_scale(
        "us_arch:3_8_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/8″ = 1′-0″",
        32,
    ),
    us_scale(
        "us_arch:1_2_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/2″ = 1′-0″",
        24,
    ),
    us_scale(
        "us_arch:3_4_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/4″ = 1′-0″",
        16,
    ),
    us_scale(
        "us_arch:1_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1″ = 1′-0″",
        12,
    ),
    us_scale(
        "us_eng:1_in_10_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 10′",
        120,
    ),
    us_scale(
        "us_eng:1_in_20_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 20′",
        240,
    ),
    us_scale(
        "us_eng:1_in_30_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 30′",
        360,
    ),
    us_scale(
        "us_eng:1_in_40_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 40′",
        480,
    ),
    us_scale(
        "us_eng:1_in_50_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 50′",
        600,
    ),
    us_scale(
        "us_eng:1_in_60_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 60′",
        720,
    ),
    us_scale(
        "us_eng:1_in_100_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 100′",
        1_200,
    ),
];

/// Metric scale-bar and grid/snap nice step ladder in metres (`10 cm`..`10 km`).
pub const SCALE_BAR_STEPS_METRIC_M: &[f64] = &[
    0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1_000.0, 2_000.0, 5_000.0,
    10_000.0,
];

/// US customary scale-bar and grid/snap nice step ladder in metres
/// (`6 in`, `1 ft`..`2,000 ft`, `1 mi`..`5 mi`).
pub const SCALE_BAR_STEPS_US_M: &[f64] = &[
    6.0 * C.m_per_inch,
    C.m_per_foot,
    2.0 * C.m_per_foot,
    5.0 * C.m_per_foot,
    10.0 * C.m_per_foot,
    20.0 * C.m_per_foot,
    50.0 * C.m_per_foot,
    100.0 * C.m_per_foot,
    200.0 * C.m_per_foot,
    500.0 * C.m_per_foot,
    1_000.0 * C.m_per_foot,
    2_000.0 * C.m_per_foot,
    C.m_per_mile,
    2.0 * C.m_per_mile,
    5.0 * C.m_per_mile,
];

/// Returns the nice step ladder in metres for `system`.
#[must_use]
pub const fn scale_bar_steps(system: UnitSystem) -> &'static [f64] {
    match system {
        UnitSystem::Metric => SCALE_BAR_STEPS_METRIC_M,
        UnitSystem::UsCustomary => SCALE_BAR_STEPS_US_M,
    }
}

/// Returns the largest nice step in metres `<= max_m` for `system`
/// (or the smallest step if `max_m` is below the ladder floor or non-finite).
#[must_use]
pub fn nice_distance_at_most(max_m: f64, system: UnitSystem) -> f64 {
    let steps = scale_bar_steps(system);
    if !max_m.is_finite() || max_m <= steps[0] {
        return steps[0];
    }
    let mut chosen = steps[0];
    for &step in steps {
        if step <= max_m {
            chosen = step;
        } else {
            break;
        }
    }
    chosen
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        PDF_SCALES, PdfScaleGroup, SCALE_BAR_STEPS_METRIC_M, SCALE_BAR_STEPS_US_M, UnitSystem,
        nice_distance_at_most,
    };

    #[test]
    fn pdf_scales_and_scale_bar_ladders_are_valid_and_ordered() {
        let mut ids = HashSet::new();
        let mut counts = (0usize, 0usize, 0usize);
        for scale in PDF_SCALES {
            assert!(ids.insert(scale.id), "duplicate PDF scale id {}", scale.id);
            assert!(scale.denominator > 0);
            match scale.group {
                PdfScaleGroup::Ratio => {
                    assert!(scale.metric && scale.us_customary);
                    assert!(scale.label.is_none(), "ratio labels format with Intl");
                    counts.0 += 1;
                }
                PdfScaleGroup::UsArchitectural => {
                    assert!(!scale.metric && scale.us_customary);
                    assert!(scale.label.is_some());
                    counts.1 += 1;
                }
                PdfScaleGroup::UsEngineering => {
                    assert!(!scale.metric && scale.us_customary);
                    assert!(scale.label.is_some());
                    counts.2 += 1;
                }
                PdfScaleGroup::Fit => panic!("PDF_SCALES holds fixed-ratio scales only"),
            }
        }
        assert_eq!(counts, (9, 9, 7));

        for ladder in [SCALE_BAR_STEPS_METRIC_M, SCALE_BAR_STEPS_US_M] {
            for pair in ladder.windows(2) {
                assert!(pair[1] > pair[0], "ladder must be strictly increasing");
            }
        }
        assert_eq!(nice_distance_at_most(0.0, UnitSystem::Metric), 0.1);
        assert_eq!(nice_distance_at_most(35.0, UnitSystem::Metric), 20.0);
        assert_eq!(nice_distance_at_most(1_500.0, UnitSystem::Metric), 1_000.0);
        assert_eq!(
            nice_distance_at_most(1_609.344, UnitSystem::UsCustomary),
            1_609.344
        );
    }
}

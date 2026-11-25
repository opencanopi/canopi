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
    /// Canonical scale label (`1:100`, `1/8″ = 1′-0″`, `1″ = 20′`).
    pub label: &'static str,
    /// Exact denominator `D` of the `1 : D` map ratio.
    pub denominator: u32,
    /// Offered when `unit_system == Metric`.
    pub metric: bool,
    /// Offered when `unit_system == UsCustomary`.
    pub us_customary: bool,
}

const fn scale(
    id: &'static str,
    group: PdfScaleGroup,
    label: &'static str,
    denominator: u32,
    metric: bool,
    us_customary: bool,
) -> PdfScaleSpec {
    PdfScaleSpec {
        id,
        group,
        label,
        denominator,
        metric,
        us_customary,
    }
}

/// Operator-approved PDF scale picker list (`2.1-Q133`, `2.1-Q356`).
pub const PDF_SCALES: &[PdfScaleSpec] = &[
    scale("ratio:50", PdfScaleGroup::Ratio, "1:50", 50, true, true),
    scale("ratio:100", PdfScaleGroup::Ratio, "1:100", 100, true, true),
    scale("ratio:200", PdfScaleGroup::Ratio, "1:200", 200, true, true),
    scale("ratio:250", PdfScaleGroup::Ratio, "1:250", 250, true, true),
    scale("ratio:500", PdfScaleGroup::Ratio, "1:500", 500, true, true),
    scale(
        "ratio:1000",
        PdfScaleGroup::Ratio,
        "1:1,000",
        1_000,
        true,
        true,
    ),
    scale(
        "ratio:2000",
        PdfScaleGroup::Ratio,
        "1:2,000",
        2_000,
        true,
        true,
    ),
    scale(
        "ratio:2500",
        PdfScaleGroup::Ratio,
        "1:2,500",
        2_500,
        true,
        true,
    ),
    scale(
        "ratio:5000",
        PdfScaleGroup::Ratio,
        "1:5,000",
        5_000,
        true,
        true,
    ),
    scale(
        "us_arch:1_16_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/16″ = 1′-0″",
        192,
        false,
        true,
    ),
    scale(
        "us_arch:3_32_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/32″ = 1′-0″",
        128,
        false,
        true,
    ),
    scale(
        "us_arch:1_8_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/8″ = 1′-0″",
        96,
        false,
        true,
    ),
    scale(
        "us_arch:3_16_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/16″ = 1′-0″",
        64,
        false,
        true,
    ),
    scale(
        "us_arch:1_4_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/4″ = 1′-0″",
        48,
        false,
        true,
    ),
    scale(
        "us_arch:3_8_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/8″ = 1′-0″",
        32,
        false,
        true,
    ),
    scale(
        "us_arch:1_2_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1/2″ = 1′-0″",
        24,
        false,
        true,
    ),
    scale(
        "us_arch:3_4_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "3/4″ = 1′-0″",
        16,
        false,
        true,
    ),
    scale(
        "us_arch:1_in_1_ft",
        PdfScaleGroup::UsArchitectural,
        "1″ = 1′-0″",
        12,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_10_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 10′",
        120,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_20_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 20′",
        240,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_30_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 30′",
        360,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_40_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 40′",
        480,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_50_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 50′",
        600,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_60_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 60′",
        720,
        false,
        true,
    ),
    scale(
        "us_eng:1_in_100_ft",
        PdfScaleGroup::UsEngineering,
        "1″ = 100′",
        1_200,
        false,
        true,
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

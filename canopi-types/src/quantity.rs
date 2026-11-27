//! Single-source-of-truth quantity table for Metric and US Customary display,
//! input parsing, PDF scale pickers, and scale-bar nice steps (contracts §14,
//! F35, `2.1-Q120`, `2.1-Q133`, `2.1-Q169`, `2.1-Q356`).
//!
//! Storage stays SI everywhere (`.canopi` files, Drafts, species catalog,
//! runtime geometry). `bindings-gen` emits `desktop/web/src/generated/quantity-table.ts`
//! from this module.

mod scales;
mod tables;

use serde::{Deserialize, Serialize};
use specta::Type;

pub use scales::{
    PDF_SCALES, PdfScaleGroup, PdfScaleSpec, SCALE_BAR_STEPS_METRIC_M, SCALE_BAR_STEPS_US_M,
    nice_distance_at_most, scale_bar_steps,
};
pub use tables::{
    QUANTITIES, is_whole_si_unit, select_display_band, select_display_style, spec_for,
};

/// User-selected device unit system (contracts §14, `2.1-Q120`, `2.1-Q169`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UnitSystem {
    /// SI metric display units (`cm`, `m`, `km`, `m²`, `ha`, `°C`, `mm`, `L`).
    Metric,
    /// US customary display units (`in`, `ft`, `mi`, `ft²`, `acres`, `°F`, `US gal`).
    UsCustomary,
}

impl UnitSystem {
    /// Every unit system in canonical order.
    pub const ALL: &'static [Self] = &[Self::Metric, Self::UsCustomary];

    /// Stable wire and table key.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Metric => "metric",
            Self::UsCustomary => "us_customary",
        }
    }
}

/// ISO 3166-1 alpha-2 region codes that default to [`UnitSystem::UsCustomary`]
/// on first run (`2.1-Q120`, `2.1-Q169`): United States, Liberia, and Myanmar.
pub const US_CUSTOMARY_REGIONS: &[&str] = &["US", "LR", "MM"];

/// Returns the first-run default [`UnitSystem`] for an ISO 3166-1 alpha-2
/// region code (`US`, `LR`, `MM` -> `UsCustomary`; all others -> `Metric`).
#[must_use]
pub fn default_unit_system_for_region(region: Option<&str>) -> UnitSystem {
    let Some(raw) = region.map(str::trim).filter(|s| !s.is_empty()) else {
        return UnitSystem::Metric;
    };
    if US_CUSTOMARY_REGIONS
        .iter()
        .any(|code| code.eq_ignore_ascii_case(raw))
    {
        UnitSystem::UsCustomary
    } else {
        UnitSystem::Metric
    }
}

/// Exact unit conversion constants owned by the quantity table (contracts §18 F35).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConversionConstants {
    /// Metres per millimetre (`0.001`).
    pub m_per_mm: f64,
    /// Metres per centimetre (`0.01`).
    pub m_per_cm: f64,
    /// Metres per kilometre (`1000.0`).
    pub m_per_km: f64,
    /// Exact international metres per inch (`0.0254`).
    pub m_per_inch: f64,
    /// Exact inches per foot (`12.0`).
    pub inches_per_foot: f64,
    /// Exact international metres per foot (`0.3048`).
    pub m_per_foot: f64,
    /// Exact feet per statute mile (`5280.0`).
    pub feet_per_mile: f64,
    /// Exact metres per statute mile (`1609.344`).
    pub m_per_mile: f64,
    /// Square metres per square centimetre (`0.0001`).
    pub m2_per_cm2: f64,
    /// Square metres per hectare (`10000.0`).
    pub m2_per_hectare: f64,
    /// Square metres per square kilometre (`1000000.0`).
    pub m2_per_km2: f64,
    /// Exact square metres per square inch (`0.00064516`).
    pub m2_per_sq_inch: f64,
    /// Exact square metres per square foot (`0.09290304`).
    pub m2_per_sq_foot: f64,
    /// Exact square feet per acre (`43560.0`).
    pub sq_feet_per_acre: f64,
    /// Exact square metres per acre (`4046.8564224`).
    pub m2_per_acre: f64,
    /// Exact millimetres per centimetre (`10.0`).
    pub mm_per_cm: f64,
    /// Exact millimetres per inch (`25.4`).
    pub mm_per_inch: f64,
    /// Exact litres per millilitre (`0.001`).
    pub liters_per_ml: f64,
    /// Exact litres per US liquid gallon (`3.785411784`).
    pub liters_per_us_gallon: f64,
    /// Fahrenheit degrees per Celsius degree (`1.8`).
    pub fahrenheit_scale: f64,
    /// Fahrenheit freezing point offset (`32.0`).
    pub fahrenheit_offset: f64,
}

/// Single authoritative table of exact SI conversion constants (F35).
pub const CONVERSION_CONSTANTS: ConversionConstants = ConversionConstants {
    m_per_mm: 0.001,
    m_per_cm: 0.01,
    m_per_km: 1_000.0,
    m_per_inch: 0.0254,
    inches_per_foot: 12.0,
    m_per_foot: 0.3048,
    feet_per_mile: 5_280.0,
    m_per_mile: 1_609.344,
    m2_per_cm2: 0.0001,
    m2_per_hectare: 10_000.0,
    m2_per_km2: 1_000_000.0,
    m2_per_sq_inch: 0.000_645_16,
    m2_per_sq_foot: 0.092_903_04,
    sq_feet_per_acre: 43_560.0,
    m2_per_acre: 4_046.856_422_4,
    mm_per_cm: 10.0,
    mm_per_inch: 25.4,
    liters_per_ml: 0.001,
    liters_per_us_gallon: 3.785_411_784,
    fahrenheit_scale: 1.8,
    fahrenheit_offset: 32.0,
};

/// Closed set of physical quantities governed by the unit system (contracts §14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum QuantityKind {
    /// Ground and object length, stored in metres.
    Length,
    /// Surface area, stored in square metres.
    Area,
    /// Air or soil temperature, stored in degrees Celsius.
    Temperature,
    /// Precipitation depth, stored in millimetres.
    Rainfall,
    /// Liquid volume, stored in litres.
    Volume,
    /// Raster pixel size, stored in metres (follows the Length display rule).
    RasterResolution,
    /// Species catalog plant dimensions, stored in metres (preserves source precision).
    CatalogSize,
}

impl QuantityKind {
    /// Every governed quantity in canonical order.
    pub const ALL: &'static [Self] = &[
        Self::Length,
        Self::Area,
        Self::Temperature,
        Self::Rainfall,
        Self::Volume,
        Self::RasterResolution,
        Self::CatalogSize,
    ];

    /// Stable table key.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Length => "length",
            Self::Area => "area",
            Self::Temperature => "temperature",
            Self::Rainfall => "rainfall",
            Self::Volume => "volume",
            Self::RasterResolution => "raster_resolution",
            Self::CatalogSize => "catalog_size",
        }
    }
}

/// Identifier for a concrete display or input unit in the quantity table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UnitId {
    /// Millimetre (`mm`).
    Millimeter,
    /// Centimetre (`cm`).
    Centimeter,
    /// Metre (`m`).
    Meter,
    /// Kilometre (`km`).
    Kilometer,
    /// International inch (`in`).
    Inch,
    /// International foot (`ft`).
    Foot,
    /// Statute mile (`mi`).
    Mile,
    /// Square centimetre (`cm²`).
    SquareCentimeter,
    /// Square metre (`m²`).
    SquareMeter,
    /// Hectare (`ha`).
    Hectare,
    /// Square kilometre (`km²`).
    SquareKilometer,
    /// Square inch (`in²`).
    SquareInch,
    /// Square foot (`ft²`).
    SquareFoot,
    /// International acre (`acres`).
    Acre,
    /// Degrees Celsius (`°C`).
    Celsius,
    /// Degrees Fahrenheit (`°F`).
    Fahrenheit,
    /// Millilitre (`mL`).
    Milliliter,
    /// Litre (`L`).
    Liter,
    /// US liquid gallon (`US gal`).
    UsGallon,
}

impl UnitId {
    /// Every unit in canonical order.
    pub const ALL: &'static [Self] = &[
        Self::Millimeter,
        Self::Centimeter,
        Self::Meter,
        Self::Kilometer,
        Self::Inch,
        Self::Foot,
        Self::Mile,
        Self::SquareCentimeter,
        Self::SquareMeter,
        Self::Hectare,
        Self::SquareKilometer,
        Self::SquareInch,
        Self::SquareFoot,
        Self::Acre,
        Self::Celsius,
        Self::Fahrenheit,
        Self::Milliliter,
        Self::Liter,
        Self::UsGallon,
    ];

    /// Stable unit key.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Millimeter => "mm",
            Self::Centimeter => "cm",
            Self::Meter => "m",
            Self::Kilometer => "km",
            Self::Inch => "in",
            Self::Foot => "ft",
            Self::Mile => "mi",
            Self::SquareCentimeter => "cm2",
            Self::SquareMeter => "m2",
            Self::Hectare => "ha",
            Self::SquareKilometer => "km2",
            Self::SquareInch => "in2",
            Self::SquareFoot => "ft2",
            Self::Acre => "acre",
            Self::Celsius => "celsius",
            Self::Fahrenheit => "fahrenheit",
            Self::Milliliter => "ml",
            Self::Liter => "l",
            Self::UsGallon => "us_gal",
        }
    }

    /// Sanctioned ECMA-402 `Intl.NumberFormat` unit identifier when available.
    ///
    /// Returns `None` for compound/squared units (`cm²`, `m²`, `km²`, `in²`, `ft²`)
    /// that are not sanctioned single-unit identifiers in ECMA-402.
    #[must_use]
    pub const fn intl_unit(self) -> Option<&'static str> {
        match self {
            Self::Millimeter => Some("millimeter"),
            Self::Centimeter => Some("centimeter"),
            Self::Meter => Some("meter"),
            Self::Kilometer => Some("kilometer"),
            Self::Inch => Some("inch"),
            Self::Foot => Some("foot"),
            Self::Mile => Some("mile"),
            Self::Hectare => Some("hectare"),
            Self::Acre => Some("acre"),
            Self::Celsius => Some("celsius"),
            Self::Fahrenheit => Some("fahrenheit"),
            Self::Milliliter => Some("milliliter"),
            Self::Liter => Some("liter"),
            Self::UsGallon => Some("gallon"),
            Self::SquareCentimeter
            | Self::SquareMeter
            | Self::SquareKilometer
            | Self::SquareInch
            | Self::SquareFoot => None,
        }
    }

    /// Canonical fallback display symbol when `Intl.NumberFormat` lacks a
    /// sanctioned unit identifier or for compound/US-explicit labels.
    #[must_use]
    pub const fn symbol(self) -> &'static str {
        match self {
            Self::Millimeter => "mm",
            Self::Centimeter => "cm",
            Self::Meter => "m",
            Self::Kilometer => "km",
            Self::Inch => "in",
            Self::Foot => "ft",
            Self::Mile => "mi",
            Self::SquareCentimeter => "cm²",
            Self::SquareMeter => "m²",
            Self::Hectare => "ha",
            Self::SquareKilometer => "km²",
            Self::SquareInch => "in²",
            Self::SquareFoot => "ft²",
            Self::Acre => "acres",
            Self::Celsius => "°C",
            Self::Fahrenheit => "°F",
            Self::Milliliter => "mL",
            Self::Liter => "L",
            Self::UsGallon => "US gal",
        }
    }
}

/// How a magnitude band formats its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayStyle {
    /// Single unit with fixed decimal places (optionally trimmed for scale bars).
    Single {
        /// Target display unit.
        unit: UnitId,
        /// Fractional digits to display.
        decimals: u8,
    },
    /// US customary feet-and-inches (`5′ 6″`). When `drop_zero_inches` is `true`
    /// (Operator Q1 Option A), whole-foot values render as `3 ft` rather than `3′ 0″`.
    FeetAndInches {
        /// Drop `0″` and render as whole `ft` when inches round to zero.
        drop_zero_inches: bool,
    },
}

/// One magnitude threshold band for a `(QuantityKind, UnitSystem)` pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayBand {
    /// Exclusive upper bound in stored SI units (`None` for the top open band).
    pub max_si_exclusive: Option<f64>,
    /// Formatting rule for values below `max_si_exclusive`.
    pub style: DisplayStyle,
}

/// One accepted input unit and its affine conversion into stored SI units:
/// `si = (value - offset_in_unit) * si_per_unit`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnitInputSpec {
    /// Unit identifier.
    pub unit: UnitId,
    /// SI units per 1 input unit.
    pub si_per_unit: f64,
    /// Zero-point offset in input units (`32.0` for Fahrenheit, `0.0` for linear units).
    pub offset_in_unit: f64,
    /// Accepted lowercase / symbol aliases recognized by the parser.
    pub aliases: &'static [&'static str],
}

/// Per-unit-system display bands and bare-number default unit for a quantity.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuantitySystemSpec {
    /// Unit assumed when the user enters a bare number with no unit suffix.
    pub bare_input_unit: UnitId,
    /// Magnitude bands in ascending `max_si_exclusive` order; last band has `None`.
    pub bands: &'static [DisplayBand],
}

/// Complete specification of one quantity in the quantity table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuantitySpec {
    /// Quantity identifier.
    pub kind: QuantityKind,
    /// Stored SI unit.
    pub si_unit: UnitId,
    /// Whether negative values are accepted by the input parser.
    pub allows_negative: bool,
    /// Whether the parser accepts compound feet-and-inches (`5′ 6″`, `5' 6"`, `5 ft 6 in`).
    pub accepts_feet_and_inches: bool,
    /// Whether converted values show an approximation prefix (`false` per Operator Q2 Option A).
    pub approximate_prefix: bool,
    /// Whether whole-SI source values `>= 1` round to whole display units
    /// (`true` for `CatalogSize` per contracts §14 & Q2 Option A: `3 m` -> `3 m` / `10 ft`,
    /// while fractional values like `1.5 m` or `2.5 m` follow the Length bands).
    pub whole_source_rounds_to_whole_unit: bool,
    /// Metric display bands and bare-number unit.
    pub metric: QuantitySystemSpec,
    /// US customary display bands and bare-number unit.
    pub us_customary: QuantitySystemSpec,
    /// Accepted input units (both systems accepted in any mode).
    pub input_units: &'static [UnitInputSpec],
}

#[cfg(test)]
mod tests {
    use super::{
        CONVERSION_CONSTANTS, DisplayStyle, QUANTITIES, QuantityKind, UnitId, UnitSystem,
        default_unit_system_for_region, select_display_band, select_display_style, spec_for,
    };

    #[test]
    fn region_defaults_match_us_liberia_myanmar_rule() {
        for code in ["US", "us", "LR", "MM", " us "] {
            assert_eq!(
                default_unit_system_for_region(Some(code)),
                UnitSystem::UsCustomary,
                "region {code}"
            );
        }
        for code in [
            None,
            Some(""),
            Some("FR"),
            Some("DE"),
            Some("GB"),
            Some("CA"),
            Some("JP"),
        ] {
            assert_eq!(
                default_unit_system_for_region(code),
                UnitSystem::Metric,
                "region {code:?}"
            );
        }
    }

    #[test]
    fn quantity_table_covers_every_kind_with_monotonic_bands_and_exact_constants() {
        assert_eq!(QUANTITIES.len(), QuantityKind::ALL.len());
        assert!(
            (CONVERSION_CONSTANTS.m_per_foot - 12.0 * CONVERSION_CONSTANTS.m_per_inch).abs()
                < 1e-15
        );
        assert!(
            (CONVERSION_CONSTANTS.m_per_mile - 5_280.0 * CONVERSION_CONSTANTS.m_per_foot).abs()
                < 1e-12
        );
        assert!(
            (CONVERSION_CONSTANTS.m2_per_sq_foot - CONVERSION_CONSTANTS.m_per_foot.powi(2)).abs()
                < 1e-15
        );
        assert!(
            (CONVERSION_CONSTANTS.m2_per_acre - 43_560.0 * CONVERSION_CONSTANTS.m2_per_sq_foot)
                .abs()
                < 1e-12
        );

        for (spec, expected) in QUANTITIES.iter().zip(QuantityKind::ALL.iter()) {
            assert_eq!(spec.kind, *expected);
            assert_eq!(spec_for(*expected), spec);
            assert!(
                !spec.approximate_prefix,
                "Operator Q2 Option A: no ~ prefix"
            );
            assert_eq!(
                spec.whole_source_rounds_to_whole_unit,
                spec.kind == QuantityKind::CatalogSize
            );
            assert_eq!(spec.allows_negative, spec.kind == QuantityKind::Temperature);
            for bands in [spec.metric.bands, spec.us_customary.bands] {
                assert!(!bands.is_empty());
                assert!(bands.last().unwrap().max_si_exclusive.is_none());
                let mut prev = 0.0_f64;
                for band in &bands[..bands.len() - 1] {
                    let limit = band.max_si_exclusive.expect("non-final band needs limit");
                    assert!(limit > prev, "bands must be strictly increasing");
                    prev = limit;
                }
            }
        }
    }

    #[test]
    fn display_bands_match_approved_v2_examples_including_de_de_1_50_km_nit() {
        // Length: 1500 m (#316 nit: de-DE renders "1,50 km", en-US renders "1.50 km").
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::Metric, 1_500.0).style,
            DisplayStyle::Single {
                unit: UnitId::Kilometer,
                decimals: 2
            }
        );
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::Metric, 0.90).style,
            DisplayStyle::Single {
                unit: UnitId::Centimeter,
                decimals: 0
            }
        );
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::Metric, 1.50).style,
            DisplayStyle::Single {
                unit: UnitId::Meter,
                decimals: 1
            }
        );
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::Metric, 10.0).style,
            DisplayStyle::Single {
                unit: UnitId::Meter,
                decimals: 0
            }
        );
        // US Length: Q1 Option A (drop_zero_inches: true) for 1 ft <= v < 10 ft.
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::UsCustomary, 0.12).style,
            DisplayStyle::Single {
                unit: UnitId::Inch,
                decimals: 0
            }
        );
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::UsCustomary, 0.9144).style,
            DisplayStyle::FeetAndInches {
                drop_zero_inches: true
            }
        );
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::UsCustomary, 10.0).style,
            DisplayStyle::Single {
                unit: UnitId::Foot,
                decimals: 0
            }
        );
        assert_eq!(
            select_display_band(QuantityKind::Length, UnitSystem::UsCustomary, 1_609.344).style,
            DisplayStyle::Single {
                unit: UnitId::Mile,
                decimals: 2
            }
        );
        // CatalogSize (contracts §14, Q2 Option A): whole-m values >= 1 m round to whole m/ft,
        // fractional values follow Length bands, and km/mi keep 2 decimals (#394 N1).
        let cat = |sys, v| select_display_style(QuantityKind::CatalogSize, sys, v);
        let single = |unit, decimals| DisplayStyle::Single { unit, decimals };
        let ft_in = DisplayStyle::FeetAndInches {
            drop_zero_inches: true,
        };
        for whole_m in [2.0, 3.0] {
            assert_eq!(cat(UnitSystem::Metric, whole_m), single(UnitId::Meter, 0));
            assert_eq!(
                cat(UnitSystem::UsCustomary, whole_m),
                single(UnitId::Foot, 0)
            );
        }
        for frac_m in [1.5, 2.5, 1.8288] {
            assert_eq!(cat(UnitSystem::Metric, frac_m), single(UnitId::Meter, 1));
            assert_eq!(cat(UnitSystem::UsCustomary, frac_m), ft_in);
        }
        assert_eq!(cat(UnitSystem::Metric, 0.5), single(UnitId::Centimeter, 0));
        assert_eq!(cat(UnitSystem::UsCustomary, 0.5), ft_in);
        assert_eq!(
            cat(UnitSystem::Metric, 1_500.0),
            single(UnitId::Kilometer, 2)
        );
        assert_eq!(
            cat(UnitSystem::UsCustomary, 2_000.0),
            single(UnitId::Mile, 2)
        );
    }
}

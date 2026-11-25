//! Static quantity display bands and accepted input units (contracts §14).

use super::{
    CONVERSION_CONSTANTS as C, DisplayBand, DisplayStyle, QuantityKind, QuantitySpec,
    QuantitySystemSpec, UnitId, UnitInputSpec, UnitSystem,
};

const fn single(max_si_exclusive: Option<f64>, unit: UnitId, decimals: u8) -> DisplayBand {
    DisplayBand {
        max_si_exclusive,
        style: DisplayStyle::Single { unit, decimals },
    }
}

const fn ft_in(max_si_exclusive: Option<f64>) -> DisplayBand {
    DisplayBand {
        max_si_exclusive,
        style: DisplayStyle::FeetAndInches {
            drop_zero_inches: true,
        },
    }
}

const fn input(unit: UnitId, si_per_unit: f64, aliases: &'static [&'static str]) -> UnitInputSpec {
    UnitInputSpec {
        unit,
        si_per_unit,
        offset_in_unit: 0.0,
        aliases,
    }
}

const LENGTH_BANDS_METRIC: &[DisplayBand] = &[
    single(Some(1.0), UnitId::Centimeter, 0),
    single(Some(10.0), UnitId::Meter, 1),
    single(Some(C.m_per_km), UnitId::Meter, 0),
    single(None, UnitId::Kilometer, 2),
];

const LENGTH_BANDS_US: &[DisplayBand] = &[
    single(Some(C.m_per_foot), UnitId::Inch, 0),
    ft_in(Some(10.0 * C.m_per_foot)),
    single(Some(C.m_per_mile), UnitId::Foot, 0),
    single(None, UnitId::Mile, 2),
];

const CATALOG_SIZE_BANDS_METRIC: &[DisplayBand] = &[
    single(Some(1.0), UnitId::Centimeter, 0),
    single(Some(C.m_per_km), UnitId::Meter, 0),
    single(None, UnitId::Kilometer, 2),
];

const CATALOG_SIZE_BANDS_US: &[DisplayBand] = &[
    single(Some(C.m_per_foot), UnitId::Inch, 0),
    ft_in(Some(1.0)),
    single(Some(C.m_per_mile), UnitId::Foot, 0),
    single(None, UnitId::Mile, 2),
];

const LENGTH_INPUT_UNITS: &[UnitInputSpec] = &[
    input(
        UnitId::Millimeter,
        C.m_per_mm,
        &[
            "mm",
            "millimeter",
            "millimeters",
            "millimetre",
            "millimetres",
        ],
    ),
    input(
        UnitId::Centimeter,
        C.m_per_cm,
        &[
            "cm",
            "centimeter",
            "centimeters",
            "centimetre",
            "centimetres",
        ],
    ),
    input(
        UnitId::Meter,
        1.0,
        &["m", "meter", "meters", "metre", "metres"],
    ),
    input(
        UnitId::Kilometer,
        C.m_per_km,
        &["km", "kilometer", "kilometers", "kilometre", "kilometres"],
    ),
    input(
        UnitId::Inch,
        C.m_per_inch,
        &["in", "inch", "inches", "\"", "″", "”"],
    ),
    input(
        UnitId::Foot,
        C.m_per_foot,
        &["ft", "foot", "feet", "'", "′", "’"],
    ),
    input(UnitId::Mile, C.m_per_mile, &["mi", "mile", "miles"]),
];

const AREA_BANDS_METRIC: &[DisplayBand] = &[
    single(Some(1.0), UnitId::SquareCentimeter, 0),
    single(Some(C.m2_per_hectare), UnitId::SquareMeter, 0),
    single(None, UnitId::Hectare, 2),
];

const AREA_BANDS_US: &[DisplayBand] = &[
    single(Some(C.m2_per_sq_foot), UnitId::SquareInch, 0),
    single(Some(C.m2_per_acre), UnitId::SquareFoot, 0),
    single(None, UnitId::Acre, 2),
];

const AREA_INPUT_UNITS: &[UnitInputSpec] = &[
    input(
        UnitId::SquareCentimeter,
        C.m2_per_cm2,
        &["cm²", "cm2", "sq cm"],
    ),
    input(UnitId::SquareMeter, 1.0, &["m²", "m2", "sq m"]),
    input(
        UnitId::Hectare,
        C.m2_per_hectare,
        &["ha", "hectare", "hectares"],
    ),
    input(
        UnitId::SquareKilometer,
        C.m2_per_km2,
        &["km²", "km2", "sq km"],
    ),
    input(
        UnitId::SquareInch,
        C.m2_per_sq_inch,
        &["in²", "in2", "sq in"],
    ),
    input(
        UnitId::SquareFoot,
        C.m2_per_sq_foot,
        &["ft²", "ft2", "sq ft"],
    ),
    input(UnitId::Acre, C.m2_per_acre, &["ac", "acre", "acres"]),
];

const TEMPERATURE_BANDS_METRIC: &[DisplayBand] = &[single(None, UnitId::Celsius, 0)];
const TEMPERATURE_BANDS_US: &[DisplayBand] = &[single(None, UnitId::Fahrenheit, 0)];

const TEMPERATURE_INPUT_UNITS: &[UnitInputSpec] = &[
    input(UnitId::Celsius, 1.0, &["°c", "c", "celsius"]),
    UnitInputSpec {
        unit: UnitId::Fahrenheit,
        si_per_unit: 5.0 / 9.0,
        offset_in_unit: C.fahrenheit_offset,
        aliases: &["°f", "f", "fahrenheit"],
    },
];

const RAINFALL_BANDS_METRIC: &[DisplayBand] = &[single(None, UnitId::Millimeter, 0)];
const RAINFALL_BANDS_US: &[DisplayBand] = &[single(None, UnitId::Inch, 1)];

const RAINFALL_INPUT_UNITS: &[UnitInputSpec] = &[
    input(
        UnitId::Millimeter,
        1.0,
        &[
            "mm",
            "millimeter",
            "millimeters",
            "millimetre",
            "millimetres",
        ],
    ),
    input(
        UnitId::Centimeter,
        10.0,
        &[
            "cm",
            "centimeter",
            "centimeters",
            "centimetre",
            "centimetres",
        ],
    ),
    input(
        UnitId::Inch,
        C.mm_per_inch,
        &["in", "inch", "inches", "\"", "″", "”"],
    ),
];

const VOLUME_BANDS_METRIC: &[DisplayBand] = &[single(None, UnitId::Liter, 1)];
const VOLUME_BANDS_US: &[DisplayBand] = &[single(None, UnitId::UsGallon, 1)];

const VOLUME_INPUT_UNITS: &[UnitInputSpec] = &[
    input(
        UnitId::Milliliter,
        0.001,
        &[
            "ml",
            "milliliter",
            "milliliters",
            "millilitre",
            "millilitres",
        ],
    ),
    input(
        UnitId::Liter,
        1.0,
        &["l", "liter", "liters", "litre", "litres"],
    ),
    input(
        UnitId::UsGallon,
        C.liters_per_us_gallon,
        &["gal", "us gal", "gallon", "gallons"],
    ),
];

/// Every governed quantity specification in canonical [`QuantityKind::ALL`] order.
pub const QUANTITIES: &[QuantitySpec] = &[
    QuantitySpec {
        kind: QuantityKind::Length,
        si_unit: UnitId::Meter,
        allows_negative: false,
        accepts_feet_and_inches: true,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::Meter,
            bands: LENGTH_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::Foot,
            bands: LENGTH_BANDS_US,
        },
        input_units: LENGTH_INPUT_UNITS,
    },
    QuantitySpec {
        kind: QuantityKind::Area,
        si_unit: UnitId::SquareMeter,
        allows_negative: false,
        accepts_feet_and_inches: false,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::SquareMeter,
            bands: AREA_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::SquareFoot,
            bands: AREA_BANDS_US,
        },
        input_units: AREA_INPUT_UNITS,
    },
    QuantitySpec {
        kind: QuantityKind::Temperature,
        si_unit: UnitId::Celsius,
        allows_negative: true,
        accepts_feet_and_inches: false,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::Celsius,
            bands: TEMPERATURE_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::Fahrenheit,
            bands: TEMPERATURE_BANDS_US,
        },
        input_units: TEMPERATURE_INPUT_UNITS,
    },
    QuantitySpec {
        kind: QuantityKind::Rainfall,
        si_unit: UnitId::Millimeter,
        allows_negative: false,
        accepts_feet_and_inches: false,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::Millimeter,
            bands: RAINFALL_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::Inch,
            bands: RAINFALL_BANDS_US,
        },
        input_units: RAINFALL_INPUT_UNITS,
    },
    QuantitySpec {
        kind: QuantityKind::Volume,
        si_unit: UnitId::Liter,
        allows_negative: false,
        accepts_feet_and_inches: false,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::Liter,
            bands: VOLUME_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::UsGallon,
            bands: VOLUME_BANDS_US,
        },
        input_units: VOLUME_INPUT_UNITS,
    },
    QuantitySpec {
        kind: QuantityKind::RasterResolution,
        si_unit: UnitId::Meter,
        allows_negative: false,
        accepts_feet_and_inches: true,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::Meter,
            bands: LENGTH_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::Foot,
            bands: LENGTH_BANDS_US,
        },
        input_units: LENGTH_INPUT_UNITS,
    },
    QuantitySpec {
        kind: QuantityKind::CatalogSize,
        si_unit: UnitId::Meter,
        allows_negative: false,
        accepts_feet_and_inches: true,
        approximate_prefix: false,
        metric: QuantitySystemSpec {
            bare_input_unit: UnitId::Meter,
            bands: CATALOG_SIZE_BANDS_METRIC,
        },
        us_customary: QuantitySystemSpec {
            bare_input_unit: UnitId::Foot,
            bands: CATALOG_SIZE_BANDS_US,
        },
        input_units: LENGTH_INPUT_UNITS,
    },
];

/// Returns the quantity specification for `kind`.
#[must_use]
pub const fn spec_for(kind: QuantityKind) -> &'static QuantitySpec {
    let index = match kind {
        QuantityKind::Length => 0,
        QuantityKind::Area => 1,
        QuantityKind::Temperature => 2,
        QuantityKind::Rainfall => 3,
        QuantityKind::Volume => 4,
        QuantityKind::RasterResolution => 5,
        QuantityKind::CatalogSize => 6,
    };
    &QUANTITIES[index]
}

/// Selects the display band for a non-negative SI magnitude `abs_si`.
#[must_use]
pub fn select_display_band(
    kind: QuantityKind,
    system: UnitSystem,
    abs_si: f64,
) -> &'static DisplayBand {
    let spec = spec_for(kind);
    let bands = match system {
        UnitSystem::Metric => spec.metric.bands,
        UnitSystem::UsCustomary => spec.us_customary.bands,
    };
    for band in bands {
        match band.max_si_exclusive {
            Some(limit) if abs_si < limit => return band,
            None => return band,
            Some(_) => {}
        }
    }
    &bands[bands.len() - 1]
}

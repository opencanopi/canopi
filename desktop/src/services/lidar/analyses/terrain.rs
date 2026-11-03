//! Terrain analyses.

use super::windowed::{self, WindowedTool};
use super::{AnalysisExecutor, ExecutorOutcome, RunContext};

/// `terrain.slope@1`: the pinned GeoLibre projected slope, a 5×5 Florinsky
/// stencil (two-cell halo) with `z_factor=1`, in degrees or percent. The
/// tool substitutes the valid centre for missing neighbours, so quality is 1
/// only where the whole 5×5 input was valid.
pub(super) struct Slope;

pub(super) static SLOPE: Slope = Slope;

impl AnalysisExecutor for Slope {
    fn analysis_id(&self) -> &'static str {
        "terrain.slope"
    }

    fn run(&self, context: &RunContext<'_>) -> Result<ExecutorOutcome, String> {
        let unit = canopi_types::analysis_registry::choice(context.parameters, "unit")
            .ok_or_else(|| "slope needs a unit".to_string())?;
        let output = context.output("slope")?;
        let tool = WindowedTool {
            tool: "slope",
            args: vec![format!("--units={unit}"), "--z_factor=1".to_string()],
            // A slope is never negative, so a negative marker cannot collide.
            marker_is_unambiguous: |marker| marker < 0.0,
            stencil_quality: true,
        };
        let engine = context.library.inner.geolibre.discover()?;
        let staged = windowed::run(context, "dem", output, &tool)?;
        Ok(ExecutorOutcome {
            outputs: vec![staged],
            tool: engine.provenance(vec![tool.tool.to_string()]),
        })
    }
}

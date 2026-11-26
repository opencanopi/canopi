import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHoveredPanelTargets,
  clearPanelOriginTargets,
  clearSelectedPanelTargetsForOrigin,
  readPanelOriginTargets,
  subscribePanelOriginTargetChanges,
  setHoveredPanelTargets,
  setSelectedPanelTargets,
} from "../app/panel-targets/presentation";
import {
  hoveredPanelTargets,
  selectedPanelTargetOrigin,
  selectedPanelTargets,
} from "../app/panel-targets/state";
import { setStoryPresentationOverrides } from "../app/story-presentation/overrides";
import { mapLayers } from "../app/settings/state";
import { speciesTarget } from "../target";

describe("Target Presentation", () => {
  beforeEach(() => {
    hoveredPanelTargets.value = [];
    selectedPanelTargets.value = [];
    selectedPanelTargetOrigin.value = null;
    setStoryPresentationOverrides(null);
  });

  it("canopi-rg4q: the canvas rings a presented story step's targets alone, and redraws when the step changes", () => {
    setSelectedPanelTargets("consortium", [speciesTarget("Malus domestica")]);
    let changes = 0;
    const stop = subscribePanelOriginTargetChanges(() => { changes += 1; });
    const stepTargets = [speciesTarget("Pyrus communis")];
    setStoryPresentationOverrides({
      mapLayers: mapLayers.peek(), siteDataIds: new Set(), plantLabels: "names", targets: stepTargets,
    });
    expect(readPanelOriginTargets()).toEqual(stepTargets);
    expect(changes).toBe(2);
    setStoryPresentationOverrides(null);
    expect(readPanelOriginTargets()).toEqual([speciesTarget("Malus domestica")]);
    stop();
  });

  it("deduplicates repeated hover writes", () => {
    const targets = [speciesTarget("Malus domestica")];

    setHoveredPanelTargets(targets);
    const firstRef = hoveredPanelTargets.value;
    setHoveredPanelTargets(targets);

    expect(hoveredPanelTargets.value).toEqual(targets);
    expect(hoveredPanelTargets.value).toBe(firstRef);

    clearHoveredPanelTargets();
    expect(hoveredPanelTargets.value).toEqual([]);
  });

  it("clears selected targets only for the owning origin", () => {
    const targets = [speciesTarget("Malus domestica")];

    setSelectedPanelTargets("timeline", targets);
    clearSelectedPanelTargetsForOrigin("budget");

    expect(selectedPanelTargets.value).toEqual(targets);
    expect(selectedPanelTargetOrigin.value).toBe("timeline");

    clearSelectedPanelTargetsForOrigin("timeline");

    expect(selectedPanelTargets.value).toEqual([]);
    expect(selectedPanelTargetOrigin.value).toBe(null);
  });

  it("clears all panel-origin bridge state on teardown", () => {
    hoveredPanelTargets.value = [speciesTarget("Hovered")];
    setSelectedPanelTargets("budget", [speciesTarget("Selected")]);

    clearPanelOriginTargets();

    expect(hoveredPanelTargets.value).toEqual([]);
    expect(selectedPanelTargets.value).toEqual([]);
    expect(selectedPanelTargetOrigin.value).toBe(null);
  });

  it("keeps panel-origin target state behind the presentation seam", () => {
    const selected = speciesTarget("Selected");
    const hovered = speciesTarget("Hovered");

    setSelectedPanelTargets("timeline", [selected]);
    setHoveredPanelTargets([hovered]);

    expect(readPanelOriginTargets()).toEqual([selected, hovered]);
  });
});

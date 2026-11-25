import type * as Contracts from '../generated/contracts'

export type Layer = Contracts.Layer
export type Zone = Contracts.Zone
export type Annotation = Contracts.Annotation
export type MeasurementGuide = Contracts.MeasurementGuide
export type ObjectGroup = Contracts.ObjectGroup
export type DesignSummary = Contracts.DesignSummary
export type DesignNotebookEntry = Contracts.DesignNotebookEntry
export type DesignNotebookSection = Contracts.DesignNotebookSection
export type DesignNotebookSnapshot = Contracts.DesignNotebookSnapshot
export type SavedView = Contracts.SavedView
export type SavedViewCamera = Contracts.SavedViewCamera
export type SavedViewObject = Contracts.SavedViewObject
export type RichTextBlock = Contracts.RichTextBlock
export type RichTextSpan = Contracts.RichTextSpan
export type Story = Contracts.Story
export type StoryStep = Contracts.StoryStep
export type StoryImage = Contracts.StoryImage

export type PlacedPlant = Contracts.PlacedPlant

/** A Design in memory: the file's fields, with unknown root fields under `extra`. */
export type CanopiFile = Contracts.CanopiFile & { extra?: Record<string, unknown> }

// SPDX-License-Identifier: AGPL-3.0-only
import {
  getFrameworkPreset,
  listFrameworkPresets,
  presetIdForStack,
} from "@ploydok/shared"
import type { FrameworkPreset, StackClassification } from "@ploydok/shared"

export type BuildPreset = FrameworkPreset

export type ExplainableClassification = StackClassification

export function getBuildPresets(): Array<BuildPreset> {
  return listFrameworkPresets()
}

export function asExplainableClassification(
  classification: StackClassification | null | undefined
): ExplainableClassification | null {
  return classification ?? null
}

export function presetForClassification(
  classification: ExplainableClassification | null | undefined,
  presets: ReadonlyArray<BuildPreset>
): BuildPreset | null {
  if (!classification || classification.ambiguous) return null
  if (classification.preset) return classification.preset
  const id =
    classification.presetId ??
    presetIdForStack(classification.stack, classification.framework)
  return (
    presets.find((preset) => preset.id === id) ?? getFrameworkPreset(id) ?? null
  )
}

export function presetOptionsForClassification(
  _classification: ExplainableClassification | null | undefined,
  presets: ReadonlyArray<BuildPreset>
): Array<BuildPreset> {
  return [...presets]
}

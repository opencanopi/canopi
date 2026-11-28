import type { BudgetItem } from '../../types/design'
import { getBudgetSpeciesTarget, targets, speciesBudgetTarget } from '../../target'
import { DEFAULT_BUDGET_CURRENCY } from '../contracts/document'
import { editCurrentDesign } from './core'

export function setBudgetCurrency(currency: string): void {
  editCurrentDesign((design) => {
    if (design.budget_currency === currency) return design
    return {
      ...design,
      budget_currency: currency,
    }
  }, 'budget.currency')
}

export function setPlantBudgetPrice(canonicalName: string, unitCost: number): void {
  const sanitized = Math.max(0, Number.isFinite(unitCost) ? unitCost : 0)
  const target = speciesBudgetTarget(canonicalName)
  editCurrentDesign((design) => {
    const currency = design.budget_currency ?? DEFAULT_BUDGET_CURRENCY
    const budget = design.budget
    const index = budget.findIndex((item) => {
      const itemTarget = getBudgetSpeciesTarget(item)
      return itemTarget !== null && targets.equals(itemTarget, target)
    })
    const existing = index !== -1 ? budget[index] : undefined
    if (existing && existing.unit_cost === sanitized) return design

    const next: BudgetItem = existing
      ? { ...existing, unit_cost: sanitized }
      : { target, unit_cost: sanitized }

    return {
      ...design,
      budget_currency: currency,
      budget: index === -1
        ? [...budget, next]
        : budget.map((item, itemIndex) => (itemIndex === index ? next : item)),
    }
  }, 'budget.price')
}

export function deletePlantBudgetPrice(canonicalName: string): void {
  const target = speciesBudgetTarget(canonicalName)
  editCurrentDesign((design) => {
    const nextBudget = design.budget.filter((item) => {
      const itemTarget = getBudgetSpeciesTarget(item)
      return itemTarget === null || !targets.equals(itemTarget, target)
    })
    if (nextBudget.length === design.budget.length) return design
    return { ...design, budget: nextBudget }
  }, 'budget.delete')
}

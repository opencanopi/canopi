import type { BudgetItem } from '../../generated/contracts'
import { getBudgetSpeciesTarget, targets, speciesBudgetTarget } from '../../target'
import { DEFAULT_BUDGET_CURRENCY } from '../contracts/document'
import { editCurrentDesign } from './core'

export function setBudgetCurrency(currency: string): void {
  editCurrentDesign((design) => {
    if (design.budget_currency === currency) return design
    return {
      ...design,
      budget_currency: currency,
      budget: design.budget.map((item) => ({ ...item, currency })),
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
      if (item.category !== 'plants') return false
      const itemTarget = getBudgetSpeciesTarget(item)
      return itemTarget !== null && targets.equals(itemTarget, target)
    })
    const existing = index !== -1 ? budget[index] : undefined
    if (existing && existing.unit_cost === sanitized && existing.currency === currency) return design

    const next: BudgetItem = {
      target,
      category: 'plants',
      description: canonicalName,
      quantity: existing?.quantity ?? 0,
      unit_cost: sanitized,
      currency,
    }

    return {
      ...design,
      budget_currency: currency,
      budget: index === -1
        ? [...budget, next]
        : budget.map((item, itemIndex) => (itemIndex === index ? next : item)),
    }
  }, 'budget.price')
}

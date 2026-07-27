import { describe, expect, it } from 'vitest'
import { formatCost as formatChartCost } from './analytics-chart-card'
import { formatCost as formatSummaryCost } from './analytics-summary-card'
import { formatCost as formatTopModelCost } from './top-models-card'
import { formatCostUsd as formatLedgerCost } from './cost-ledger-card'

describe('dashboard cost evidence formatting', () => {
  it('never renders missing evidence as zero dollars', () => {
    expect(formatChartCost(null, 'unavailable')).toBe('Cost unavailable')
    expect(formatSummaryCost(null, 'unavailable')).toBe('Cost unavailable')
    expect(formatTopModelCost(null, 'unavailable')).toBe('Unavailable')
    expect(formatLedgerCost(null)).toBe('Unavailable')
  })

  it('labels partial estimates and preserves an evidenced exact zero', () => {
    expect(formatChartCost(0.01, 'partial')).toBe('$0.010 partial')
    expect(formatSummaryCost(0.01, 'partial')).toBe('Partial $0.01')
    expect(formatTopModelCost(0.01, 'partial')).toBe('$0.010 partial')
    expect(formatChartCost(0, 'complete')).toBe('$0')
  })
})

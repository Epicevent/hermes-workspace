import { useMemo } from 'react'
import type { DashboardOverview } from '@/server/dashboard-aggregator'

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatCostUsd(usd: number | null): string {
  if (usd === null) return 'Unavailable'
  if (usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString()}`
}

/**
 * Per-model cost ledger.
 *
 * Receipt-backed per-model estimates. Missing cost evidence remains
 * unavailable and a partial ledger is labelled explicitly:
 *
 *   - Known estimates sort by cost descending.
 *   - Unknown rows show token volume only as context, never as $0.
 *   - Model-name regexes never decide whether a call was free.
 *
 * Default-hidden so we don't reintroduce the noise on the main
 * layout; lives in the edit-mode menu for users who want to track
 * spend explicitly.
 */
export function CostLedgerCard({
  analytics,
}: {
  analytics: DashboardOverview['analytics']
}) {
  const rows = useMemo(() => {
    if (!analytics || analytics.source !== 'analytics') return []
    return analytics.topModels.slice().sort((a, b) => {
      if (a.cost !== null && b.cost !== null) return b.cost - a.cost
      if (a.cost !== null) return -1
      if (b.cost !== null) return 1
      return b.tokens - a.tokens
    })
  }, [analytics])

  if (rows.length === 0) return null

  const knownCosts = rows
    .map((row) => row.cost)
    .filter((cost): cost is number => cost !== null)
  const knownTotal =
    knownCosts.length > 0
      ? knownCosts.reduce((sum, cost) => sum + cost, 0)
      : null

  return (
    <div
      className="relative flex flex-col gap-2 overflow-hidden rounded-xl border p-3"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--theme-card) 96%, transparent), color-mix(in srgb, var(--theme-card) 92%, transparent))',
        borderColor: 'var(--theme-border)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            'linear-gradient(90deg, var(--theme-warning), color-mix(in srgb, var(--theme-warning) 40%, transparent), transparent)',
        }}
      />

      <div className="flex items-center justify-between">
        <h3
          className="text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--theme-text)' }}
        >
          Cost ledger
        </h3>
        <span
          className="font-mono text-[9px] uppercase tracking-[0.15em]"
          style={{ color: 'var(--theme-muted)' }}
          title="Known provider-generation estimates from the receipt ledger."
        >
          {analytics?.costLabel === 'partial' ? 'Partial ' : ''}
          {formatCostUsd(knownTotal)}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {rows.slice(0, 6).map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-2 text-[10px]"
            style={{ color: 'var(--theme-muted)' }}
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              <span
                aria-hidden
                className="inline-block size-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    row.cost === null
                      ? 'var(--theme-muted)'
                      : 'var(--theme-warning)',
                }}
              />
              <span
                className="truncate font-mono uppercase tracking-[0.08em]"
                style={{ color: 'var(--theme-text)' }}
                title={row.id}
              >
                {row.id}
              </span>
            </span>
            <span
              className="shrink-0 font-mono tabular-nums"
              style={{ color: 'var(--theme-text)' }}
            >
              <span
                title={`${row.sessions} sessions \u00b7 ${row.tokens.toLocaleString()} tokens`}
              >
                {row.cost === null
                  ? `${formatTokens(row.tokens)} · unavailable`
                  : `${formatCostUsd(row.cost)}${analytics?.costLabel === 'partial' ? ' partial' : ''}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

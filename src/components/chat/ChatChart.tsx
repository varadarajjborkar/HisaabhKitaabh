'use client'

import { BarChart, LineChart } from '../charts/Charts'
import { Gauge } from '../charts/Gauge'
import type { ChartSpec } from '@/lib/ai/chart'

/**
 * A chart the assistant drew, inside the conversation.
 *
 * The same three components the analytics panel uses, at panel width. A chart
 * in a chat that looks nothing like the charts elsewhere in the app reads as
 * something bolted on, and the reason to draw one here at all is that it is the
 * same data seen from a different question.
 *
 * The note under it is not decoration. It says which files were read, which
 * words selected the rows and how many matched, because a chart of "travel
 * spend" is only worth anything if you can see what it decided travel was - and
 * disagreeing with that is the most likely useful thing a user will want to do
 * next.
 */
export function ChatChart({ spec }: { spec: ChartSpec }) {
  const points = spec.points.map((p) => ({ key: p.key, total: p.total, count: p.count }))

  return (
    <div className="animate-rise">
      {spec.kind === 'line' ? (
        <LineChart
          data={spec.points.map((p) => ({ day: p.key, total: p.total }))}
          title={spec.title}
          currency={spec.currency}
        />
      ) : spec.kind === 'donut' ? (
        <figure className="card p-4">
          <figcaption className="text-[13px] font-medium mb-2">{spec.title}</figcaption>
          <Gauge
            total={points.reduce((s, p) => s + p.total, 0)}
            slices={points}
            rowCount={spec.matchedRows}
            label="Matched"
            currency={spec.currency ?? undefined}
            compact
          />
        </figure>
      ) : (
        <BarChart data={points} title={spec.title} currency={spec.currency} />
      )}

      <p className="text-[11px] text-faint mt-1.5 leading-relaxed px-0.5">
        {spec.subtitle ? `${spec.subtitle}. ` : ''}
        {spec.note}
      </p>
    </div>
  )
}

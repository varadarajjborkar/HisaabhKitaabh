'use client'

import { useMemo, useState } from 'react'
import { Icon } from '../ui/Icons'
import { useIsDark } from '../charts/useTheme'
import { useDismiss } from '@/lib/client/useDismiss'
import { renderChartSvg } from '@/lib/charts/svg'
import { availableKinds, kindInfo, type ChartKind, type ChartSpec } from '@/lib/charts/spec'
import { themeFor } from '@/lib/charts/theme'
import { copyChartPng, downloadChartPng, downloadChartSvg } from '@/lib/client/chartImage'

/**
 * A chart the assistant drew, inside the conversation.
 *
 * What is on screen is the same SVG the download produces, from the same spec
 * through the same renderer - not a React chart that resembles an exported
 * one. Two renderers for one chart is how a picture and its file end up
 * disagreeing about a number, and this app has been bitten by that shape of
 * bug before with the clipboard and the mail draft.
 *
 * The kind switcher is here because the model picks a chart from the question,
 * and the question is not always the whole intent. Switching is instant and
 * local: the spec already carries the numbers, including the second breakdown,
 * so changing a donut to a stacked column re-runs the geometry rather than
 * going back to the files.
 *
 * The note under it is not decoration. It says which files were read, which
 * words selected the rows and how many matched, because a chart of "travel
 * spend" is only worth anything if you can see what it decided travel was.
 */
export function ChatChart({ spec }: { spec: ChartSpec }) {
  const dark = useIsDark()
  const [kind, setKind] = useState<ChartKind | null>(null)
  const [menu, setMenu] = useState<'kind' | 'save' | null>(null)
  const ref = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null))

  const shown = useMemo(() => (kind ? { ...spec, kind } : spec), [spec, kind])
  const kinds = useMemo(() => availableKinds(spec), [spec])

  const svg = useMemo(
    () => renderChartSvg(shown, { width: 340, theme: themeFor(dark) }),
    [shown, dark],
  )

  return (
    <div className="animate-rise" ref={ref}>
      <figure className="card p-3 relative">
        <figcaption className="flex items-start gap-2 mb-1.5">
          <span className="text-[13px] font-medium min-w-0 flex-1 leading-snug">{spec.title}</span>

          <span className="flex items-center gap-0.5 shrink-0 -mt-0.5 -mr-0.5">
            <button
              onClick={() => setMenu(menu === 'kind' ? null : 'kind')}
              className="h-7 px-1.5 rounded-md text-faint hover:text-ink hover:bg-raised transition-colors inline-flex items-center gap-1 text-[11px]"
              aria-label="Change chart type"
              aria-expanded={menu === 'kind'}
              title="Change chart type"
            >
              <Icon.Chart size={13} />
              <Icon.Down size={10} />
            </button>
            <button
              onClick={() => setMenu(menu === 'save' ? null : 'save')}
              className="h-7 w-7 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-raised transition-colors"
              aria-label="Save chart"
              aria-expanded={menu === 'save'}
              title="Save chart"
            >
              <Icon.Download size={14} />
            </button>
          </span>
        </figcaption>

        {/* The SVG is written by the renderer, not by JSX, so the markup here
            is identical to the file that comes out of the save menu. */}
        <div
          className="w-full [&>svg]:w-full [&>svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        {menu === 'kind' && (
          <div className="absolute right-2 top-9 z-30 card shadow-pop py-1 w-[188px] max-h-[280px] overflow-y-auto overscroll-contain animate-scale-in origin-top-right">
            {kinds.map((k) => {
              const on = (kind ?? spec.kind) === k.value
              return (
                <button
                  key={k.value}
                  onClick={() => { setKind(k.value); setMenu(null) }}
                  className={`w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-raised transition-colors flex items-center gap-2 ${on ? 'text-accent' : ''}`}
                >
                  <span className="w-3.5 shrink-0">{on && <Icon.Check size={12} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block leading-tight">{k.label}</span>
                    <span className="block text-[10.5px] text-faint leading-tight">{k.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {menu === 'save' && (
          <div className="absolute right-2 top-9 z-30 card shadow-pop py-1 w-[176px] animate-scale-in origin-top-right">
            <MenuItem icon={<Icon.Download size={13} />} label="PNG" hint="For a message" onClick={() => { setMenu(null); void downloadChartPng(shown, { dark }) }} />
            <MenuItem icon={<Icon.Download size={13} />} label="SVG" hint="Sharp at any size" onClick={() => { setMenu(null); downloadChartSvg(shown, { dark }) }} />
            <MenuItem icon={<Icon.Copy size={13} />} label="Copy image" hint="Straight to the clipboard" onClick={() => { setMenu(null); void copyChartPng(shown, { dark }) }} />
          </div>
        )}
      </figure>

      <p className="text-[11px] text-faint mt-1.5 leading-relaxed px-0.5">
        {spec.subtitle ? `${spec.subtitle}. ` : ''}
        {spec.note}
        {kind && kind !== spec.kind && <span className="text-muted"> Shown as a {kindInfo(kind).label.toLowerCase()} chart.</span>}
      </p>
    </div>
  )
}

function MenuItem({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full text-left px-2.5 py-1.5 hover:bg-raised transition-colors flex items-center gap-2">
      <span className="text-faint shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[12.5px] leading-tight">{label}</span>
        <span className="block text-[10.5px] text-faint leading-tight">{hint}</span>
      </span>
    </button>
  )
}

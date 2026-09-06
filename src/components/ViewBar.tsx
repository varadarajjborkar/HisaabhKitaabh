'use client'

import { useEffect, useState } from 'react'
import { Icon } from './ui/Icons'
import { useDismiss } from '@/lib/client/useDismiss'

export type Layout = 'grid' | 'list'

/**
 * How many items to put on screen at once.
 *
 * There is a ceiling on purpose. The home screen carries the analytics panel
 * below the folders, and a hundred folders in one go puts it a very long scroll
 * away - the list stops being a list and becomes a wall between the user and
 * the rest of the page. Paging keeps the page a fixed length whatever the
 * account grows to, and the largest option is still small enough to scroll past.
 */
export const PAGE_SIZES = [12, 24, 48] as const
export const PAGE_MAX = PAGE_SIZES[PAGE_SIZES.length - 1]

type Prefs = { layout: Layout; pageSize: number }

/** Remembered per surface, because folders and files are not looked at the same way. */
export function useViewPrefs(key: string, initial: Prefs): [Prefs, (p: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(initial)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`hisaabhkitaabh-view:${key}`)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<Prefs>
      setPrefs((p) => ({
        layout: saved.layout === 'list' || saved.layout === 'grid' ? saved.layout : p.layout,
        // A stored size from an older build, or a hand-edited one, must not be
        // able to put the whole account on one page.
        pageSize: PAGE_SIZES.includes(saved.pageSize as (typeof PAGE_SIZES)[number]) ? saved.pageSize! : p.pageSize,
      }))
    } catch { /* the defaults are a fine view */ }
  }, [key])

  const update = (patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      try { localStorage.setItem(`hisaabhkitaabh-view:${key}`, JSON.stringify(next)) } catch { /* preference only */ }
      return next
    })
  }

  return [prefs, update]
}

/** Clamp a page to what actually exists, after a filter or a size change. */
export function windowOf<T>(items: T[], page: number, pageSize: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const safe = Math.min(Math.max(0, page), pages - 1)
  return { slice: items.slice(safe * pageSize, safe * pageSize + pageSize), page: safe, pages }
}

/**
 * The controls above a list: how it looks, whether you are picking from it, and
 * how much of it is on screen.
 *
 * The layout choice is two glyphs rather than the words "Grid" and "List",
 * because the shapes say it faster than the labels do and the control has to
 * sit on a phone header next to everything else.
 */
export function ViewBar({
  layout,
  onLayout,
  selecting,
  onSelecting,
  pageSize,
  onPageSize,
  page,
  pages,
  onPage,
  total,
  noun,
}: {
  layout?: Layout
  onLayout?: (l: Layout) => void
  selecting?: boolean
  onSelecting?: (v: boolean) => void
  pageSize: number
  onPageSize: (n: number) => void
  page: number
  pages: number
  onPage: (n: number) => void
  total: number
  noun: string
}) {
  const [sizeOpen, setSizeOpen] = useState(false)
  const sizeRef = useDismiss<HTMLDivElement>(sizeOpen, () => setSizeOpen(false))

  return (
    <div className="flex items-center gap-1.5">
      {layout && onLayout && (
        <div className="flex items-center rounded-lg border border-line overflow-hidden" role="radiogroup" aria-label="Layout">
          {([['grid', Icon.Grid, 'Grid'], ['list', Icon.List, 'List']] as const).map(([value, Glyph, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={layout === value}
              aria-label={`${label} view`}
              title={`${label} view`}
              onClick={() => onLayout(value)}
              className={`h-8 w-8 grid place-items-center transition-colors ${
                layout === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink hover:bg-raised'
              }`}
            >
              <Glyph size={15} />
            </button>
          ))}
        </div>
      )}

      {onSelecting && (
        <button
          onClick={() => onSelecting(!selecting)}
          aria-pressed={selecting}
          aria-label={selecting ? 'Stop selecting' : 'Select'}
          title={selecting ? 'Stop selecting' : 'Select'}
          className={`h-8 w-8 grid place-items-center rounded-lg border transition-colors ${
            selecting ? 'bg-accent-soft border-accent/40 text-accent' : 'border-line text-muted hover:text-ink hover:bg-raised'
          }`}
        >
          <Icon.CheckSquare size={15} />
        </button>
      )}

      <div className="relative" ref={sizeRef}>
        <button
          onClick={() => setSizeOpen((v) => !v)}
          className="h-8 px-2.5 rounded-lg border border-line text-[12px] text-muted hover:text-ink hover:bg-raised
                     transition-colors inline-flex items-center gap-1 tnum"
          aria-haspopup="listbox"
          aria-expanded={sizeOpen}
          title={`Showing ${pageSize} ${noun} at a time`}
        >
          {pageSize}
          <Icon.Down size={12} />
        </button>
        {sizeOpen && (
          <div role="listbox" aria-label={`${noun} per page`} className="absolute right-0 top-full mt-1.5 z-50 w-40 card shadow-pop py-1 animate-scale-in origin-top-right">
            <p className="px-3 py-1 text-[10.5px] uppercase tracking-wide text-faint">Per page</p>
            {PAGE_SIZES.map((n) => (
              <button
                key={n}
                role="option"
                aria-selected={pageSize === n}
                onClick={() => { onPageSize(n); onPage(0); setSizeOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-raised flex items-center gap-2 transition-colors ${
                  pageSize === n ? 'text-accent' : ''
                }`}
              >
                <span className="w-3.5 shrink-0">{pageSize === n && <Icon.Check size={13} />}</span>
                {n} {noun}
              </button>
            ))}
          </div>
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center gap-1 ml-0.5">
          <button
            onClick={() => onPage(page - 1)}
            disabled={page === 0}
            className="h-8 w-8 grid place-items-center rounded-lg border border-line text-muted
                       hover:text-ink hover:bg-raised transition-colors disabled:opacity-40"
            aria-label={`Previous ${noun}`}
          >
            <Icon.Back size={15} />
          </button>
          <span className="text-[11.5px] text-faint tnum px-0.5 whitespace-nowrap" aria-live="polite">
            {page * pageSize + 1}-{Math.min(total, (page + 1) * pageSize)} of {total}
          </span>
          <button
            onClick={() => onPage(page + 1)}
            disabled={page >= pages - 1}
            className="h-8 w-8 grid place-items-center rounded-lg border border-line text-muted
                       hover:text-ink hover:bg-raised transition-colors disabled:opacity-40"
            aria-label={`Next ${noun}`}
          >
            <Icon.Chevron size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

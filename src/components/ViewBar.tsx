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
 * because the shapes say it faster than the labels do.
 *
 * On a phone the bar is not the bar. Seven controls laid across a 390px row
 * leaves each one too small to hit accurately and the row too busy to read at
 * a glance, and six of the seven are settings rather than actions: layout, page
 * size and select mode are chosen once and then left alone for weeks. Those go
 * behind a single button, and what stays on the row is what is actually used
 * while reading a list - moving between pages, and knowing where you are in it.
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
  onRefresh,
  refreshing,
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
  /** Offered here on phones, where the header has no room for its own button. */
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const [sizeOpen, setSizeOpen] = useState(false)
  const sizeRef = useDismiss<HTMLDivElement>(sizeOpen, () => setSizeOpen(false))
  const [moreOpen, setMoreOpen] = useState(false)

  const pickSize = (n: number) => { onPageSize(n); onPage(0) }

  return (
    <div className="flex items-center gap-1.5">
      {/* Phone only. Everything inside it also exists as its own control above
          the fold on a wider screen, so nothing is reachable one way only. */}
      <div className="sm:hidden">
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className={`h-9 w-9 grid place-items-center rounded-lg border transition-colors ${
            moreOpen ? 'bg-accent-soft border-accent/40 text-accent' : 'border-line text-muted'
          }`}
          aria-label="View options"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
        >
          <Icon.More size={16} />
        </button>

        {moreOpen && (
          /*
           * A sheet, not a dropdown. A menu hung off this button has nowhere
           * to go: the bar sits in the middle-right of the row, so anchoring
           * left runs off one edge of a 390px screen and anchoring right runs
           * off the other. A sheet is attached to the bottom of the window
           * instead of to the button, which fits by construction at any width
           * and puts the choices under the thumb rather than at the top of the
           * screen where the hand is not.
           */
          <>
            <div className="fixed inset-0 z-40 bg-black/30 animate-fade" onClick={() => setMoreOpen(false)} aria-hidden />
            <div
              role="menu"
              aria-label="View options"
              className="fixed inset-x-0 bottom-0 z-50 bg-surface border-t border-line rounded-t-xl2
                         shadow-pop pb-[max(0.5rem,env(safe-area-inset-bottom))] animate-sheet-up"
            >
              <div className="h-1 w-9 rounded-full bg-line mx-auto mt-2.5 mb-1" aria-hidden />

              {layout && onLayout && (
                <>
                  <MenuLabel>Layout</MenuLabel>
                  <MenuRow icon={<Icon.Grid size={15} />} on={layout === 'grid'} onClick={() => { onLayout('grid'); setMoreOpen(false) }}>
                    Grid
                  </MenuRow>
                  <MenuRow icon={<Icon.List size={15} />} on={layout === 'list'} onClick={() => { onLayout('list'); setMoreOpen(false) }}>
                    List
                  </MenuRow>
                </>
              )}

              <MenuLabel>Per page</MenuLabel>
              {PAGE_SIZES.map((n) => (
                <MenuRow key={n} on={pageSize === n} onClick={() => { pickSize(n); setMoreOpen(false) }}>
                  {n} {noun}
                </MenuRow>
              ))}

              {(onSelecting || onRefresh) && <div className="border-t border-line my-1" />}

              {onSelecting && (
                <MenuRow
                  icon={<Icon.CheckSquare size={15} />}
                  on={Boolean(selecting)}
                  onClick={() => { onSelecting(!selecting); setMoreOpen(false) }}
                >
                  {selecting ? 'Stop selecting' : `Select ${noun}`}
                </MenuRow>
              )}

              {onRefresh && (
                <MenuRow icon={<Icon.Refresh size={15} />} onClick={() => { onRefresh(); setMoreOpen(false) }}>
                  Refresh
                </MenuRow>
              )}
            </div>
          </>
        )}
      </div>

      {layout && onLayout && (
        <div
          className="hidden sm:flex items-center rounded-lg border border-line overflow-hidden"
          role="radiogroup"
          aria-label="Layout"
        >
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
        /* Once selecting is on, the way out of it stays on the row at every
           width. A mode you can enter from a menu but only leave through the
           same menu is a trap. */
        <button
          onClick={() => onSelecting(!selecting)}
          aria-pressed={selecting}
          aria-label={selecting ? 'Stop selecting' : 'Select'}
          title={selecting ? 'Stop selecting' : 'Select'}
          className={`h-9 w-9 sm:h-8 sm:w-8 place-items-center rounded-lg border transition-colors ${
            selecting ? 'grid bg-accent-soft border-accent/40 text-accent' : 'hidden sm:grid border-line text-muted hover:text-ink hover:bg-raised'
          }`}
        >
          <Icon.CheckSquare size={15} />
        </button>
      )}

      <div className="relative hidden sm:block" ref={sizeRef}>
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
                onClick={() => { pickSize(n); setSizeOpen(false) }}
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
            className="h-9 w-9 sm:h-8 sm:w-8 grid place-items-center rounded-lg border border-line text-muted
                       hover:text-ink hover:bg-raised transition-colors disabled:opacity-40"
            aria-label={`Previous ${noun}`}
          >
            <Icon.Back size={15} />
          </button>
          {/* A phone gets "2 / 8". The long form is the more useful of the two
              and it is what a mouse sees, but it is also 90px of a row that has
              none to spare. */}
          <span className="text-[11.5px] text-faint tnum px-0.5 whitespace-nowrap" aria-live="polite">
            <span className="sm:hidden">{page + 1} / {pages}</span>
            <span className="hidden sm:inline">
              {page * pageSize + 1}-{Math.min(total, (page + 1) * pageSize)} of {total}
            </span>
          </span>
          <button
            onClick={() => onPage(page + 1)}
            disabled={page >= pages - 1}
            className="h-9 w-9 sm:h-8 sm:w-8 grid place-items-center rounded-lg border border-line text-muted
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

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pt-2.5 pb-1 text-[10.5px] uppercase tracking-wide text-faint">{children}</p>
}

function MenuRow({
  children,
  icon,
  on,
  onClick,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  on?: boolean
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`w-full text-left px-4 h-12 text-[14px] flex items-center gap-2.5 transition-colors
                  active:bg-raised ${on ? 'text-accent' : 'text-ink'}`}
    >
      <span className="w-3.5 shrink-0 text-faint">{on ? <Icon.Check size={13} /> : icon}</span>
      {children}
    </button>
  )
}

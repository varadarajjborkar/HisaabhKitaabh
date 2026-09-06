'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from './ui/Icons'
import { useDismiss } from '@/lib/client/useDismiss'
import { get } from '@/lib/client/api'
import { formatMoney } from '@/lib/util/format'
import type { Hit } from '@/lib/search/rank'

const RECENT_KEY = 'hisaabhkitaabh-recent-searches'
const RECENT_MAX = 6
const DEBOUNCE_MS = 220
const MIN_CHARS = 2

/**
 * One search box, wherever you are standing.
 *
 * The same control on the home screen and inside a folder, because "find that
 * cab fare" is one intention and having to know which box answers it is a
 * detail the app should be keeping to itself. What changes with location is the
 * range, not the behaviour: inside a folder the search is limited to it, and
 * the placeholder says so.
 *
 * Typing is debounced rather than fired per keystroke. The server narrows on
 * whole terms, so a query is only worth asking once the term is a term - and a
 * request per character would spend the account's database budget on prefixes
 * nobody meant to search for.
 */
export function SearchBar({
  folderId,
  scoped = false,
  placeholder,
  value,
  onValueChange,
  className = '',
}: {
  folderId?: string | null
  /** Limit results to `folderId` instead of merely preferring it. */
  scoped?: boolean
  placeholder?: string
  /** Lifted, so a caller can filter its own list with the same text. */
  value?: string
  onValueChange?: (v: string) => void
  className?: string
}) {
  const router = useRouter()
  const [internal, setInternal] = useState('')
  const query = value ?? internal
  const setQuery = (v: string) => { setInternal(v); onValueChange?.(v) }

  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [recent, setRecent] = useState<string[]>([])

  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const inputRef = useRef<HTMLInputElement>(null)
  // Every request carries a sequence number so a slow early reply cannot land
  // on top of a fast later one and show results for a query already retyped.
  const seq = useRef(0)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY)
      if (raw) setRecent((JSON.parse(raw) as string[]).slice(0, RECENT_MAX))
    } catch { /* an empty history is a fine starting point */ }
  }, [])

  const remember = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < MIN_CHARS) return
    setRecent((prev) => {
      const next = [trimmed, ...prev.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())].slice(0, RECENT_MAX)
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* history is a convenience */ }
      return next
    })
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_CHARS) {
      setHits([])
      setBusy(false)
      return
    }
    setBusy(true)
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q })
        if (folderId) params.set('folderId', folderId)
        if (scoped) params.set('scoped', 'true')
        const res = await get<{ results: Hit[] }>(`/api/search?${params}`)
        if (seq.current !== mine) return
        setHits(res.results)
        setCursor(0)
      } catch {
        if (seq.current === mine) setHits([])
      } finally {
        if (seq.current === mine) setBusy(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, folderId, scoped])

  const go = (hit: Hit) => {
    remember(query)
    setOpen(false)
    if (hit.kind === 'folder') router.push(`/folder/${hit.id}`)
    else if (hit.kind === 'file') router.push(`/file/${hit.id}`)
    else router.push(`/file/${hit.fileId}#row-${hit.rowId}`)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return }
    if (!open || hits.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[cursor]) }
  }

  const showRecents = open && query.trim().length < MIN_CHARS && recent.length > 0
  const showResults = open && query.trim().length >= MIN_CHARS

  return (
    <div className={`relative min-w-0 ${className}`} ref={ref}>
      <Icon.Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? (scoped ? 'Search this folder' : 'Search everything')}
        className="input h-9 pl-8 pr-8 text-[13px]"
        aria-label={scoped ? 'Search this folder' : 'Search everything'}
        aria-expanded={showRecents || showResults}
        aria-controls="search-results"
        autoComplete="off"
      />
      {query && (
        <button
          onClick={() => { setQuery(''); inputRef.current?.focus() }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-ink transition-colors"
          aria-label="Clear search"
        >
          <Icon.Close size={14} />
        </button>
      )}

      {(showRecents || showResults) && (
        <div
          id="search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1.5 z-50 card shadow-pop py-1 animate-scale-in origin-top
                     max-h-[min(60dvh,460px)] overflow-y-auto overscroll-contain"
        >
          {showRecents && (
            <>
              <p className="px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-faint">Recent</p>
              {recent.map((r) => (
                <button
                  key={r}
                  onClick={() => { setQuery(r); inputRef.current?.focus() }}
                  className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-raised flex items-center gap-2 transition-colors"
                >
                  <Icon.History size={13} className="text-faint shrink-0" />
                  <span className="truncate">{r}</span>
                </button>
              ))}
            </>
          )}

          {showResults && busy && hits.length === 0 && (
            <p className="px-3 py-3 text-[12.5px] text-faint flex items-center gap-2">
              <Icon.Spinner /> Looking
            </p>
          )}

          {showResults && !busy && hits.length === 0 && (
            <p className="px-3 py-3 text-[12.5px] text-muted">
              Nothing matches “{query.trim()}”{scoped ? ' in this folder' : ''}.
            </p>
          )}

          {hits.map((hit, i) => (
            <ResultRow key={keyOf(hit)} hit={hit} active={i === cursor} onPick={() => go(hit)} onHover={() => setCursor(i)} />
          ))}
        </div>
      )}
    </div>
  )
}

function keyOf(hit: Hit): string {
  return hit.kind === 'row' ? `${hit.fileId}:${hit.rowId}` : `${hit.kind}:${hit.id}`
}

/**
 * One result, whatever kind it is.
 *
 * The three shapes share a row rather than living in three sections, because
 * the list is ranked by relevance and sections would re-sort it by category.
 * The kind is carried by the icon and by the path underneath, which is enough
 * to tell a folder from a row at a glance.
 */
function ResultRow({ hit, active, onPick, onHover }: { hit: Hit; active: boolean; onPick: () => void; onHover: () => void }) {
  const base = `w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${active ? 'bg-raised' : 'hover:bg-raised/60'}`

  if (hit.kind === 'folder') {
    return (
      <button role="option" aria-selected={active} onClick={onPick} onMouseEnter={onHover} className={base}>
        <span className="w-6 h-6 rounded grid place-items-center text-[13px] shrink-0" style={{ background: `${hit.color}1a` }}>{hit.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium truncate">{hit.name}</span>
          <span className="block text-[11px] text-faint">Folder · {hit.fileCount} file{hit.fileCount === 1 ? '' : 's'}</span>
        </span>
      </button>
    )
  }

  if (hit.kind === 'file') {
    return (
      <button role="option" aria-selected={active} onClick={onPick} onMouseEnter={onHover} className={base}>
        <Icon.File size={15} className="text-faint shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium truncate">{hit.name}</span>
          <span className="block text-[11px] text-faint truncate">{hit.folderName} · {hit.rowCount} row{hit.rowCount === 1 ? '' : 's'}</span>
        </span>
        <span className="text-[12px] tnum text-muted shrink-0">{formatMoney(hit.total, hit.currency, { decimals: false })}</span>
      </button>
    )
  }

  return (
    <button role="option" aria-selected={active} onClick={onPick} onMouseEnter={onHover} className={base}>
      <Icon.Chevron size={14} className="text-faint shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] truncate">{hit.title || hit.snippet || 'Row'}</span>
        <span className="block text-[11px] text-faint truncate">{hit.folderName} · {hit.fileName}{hit.snippet && hit.title ? ` · ${hit.snippet}` : ''}</span>
      </span>
      <span className="text-[12px] tnum text-muted shrink-0">{formatMoney(hit.amount, hit.currency, { decimals: false })}</span>
    </button>
  )
}

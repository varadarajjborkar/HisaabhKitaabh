'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icons'

/**
 * Desktop-only calculator.
 *
 * Deliberately absent on phones: every phone ships one, and a worse copy inside
 * a web app is clutter. Hidden below the `sm` breakpoint, and the launcher is
 * gated on a fine pointer so it never appears on a tablet in touch mode either.
 *
 * Expressions are evaluated by a small shunting-yard parser rather than eval:
 * a calculator that runs arbitrary strings is a liability, not a convenience.
 */

type Token = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'paren'; v: '(' | ')' }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  const s = input.replace(/[×✕]/g, '*').replace(/[÷]/g, '/').replace(/[−–]/g, '-').replace(/,/g, '')
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ') { i++; continue }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j++
      tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) })
      i = j
      continue
    }
    if (c === '(' || c === ')') { tokens.push({ t: 'paren', v: c }); i++; continue }
    if ('+-*/%^'.includes(c)) {
      // Leading or post-operator minus is a sign, not a subtraction.
      const prev = tokens[tokens.length - 1]
      if (c === '-' && (!prev || prev.t === 'op' || (prev.t === 'paren' && prev.v === '('))) {
        tokens.push({ t: 'num', v: 0 })
      }
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`Unexpected "${c}"`)
  }
  return tokens
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 }

function evaluate(input: string): number {
  const tokens = tokenize(input)
  const out: Token[] = []
  const ops: Token[] = []

  for (const tok of tokens) {
    if (tok.t === 'num') out.push(tok)
    else if (tok.t === 'op') {
      while (ops.length) {
        const top = ops[ops.length - 1]
        if (top.t === 'op' && (PREC[top.v] > PREC[tok.v] || (PREC[top.v] === PREC[tok.v] && tok.v !== '^'))) out.push(ops.pop()!)
        else break
      }
      ops.push(tok)
    } else if (tok.v === '(') ops.push(tok)
    else {
      while (ops.length && !(ops[ops.length - 1].t === 'paren')) out.push(ops.pop()!)
      if (!ops.length) throw new Error('Unbalanced brackets')
      ops.pop()
    }
  }
  while (ops.length) {
    const top = ops.pop()!
    if (top.t === 'paren') throw new Error('Unbalanced brackets')
    out.push(top)
  }

  const stack: number[] = []
  for (const tok of out) {
    if (tok.t === 'num') { stack.push(tok.v); continue }
    const b = stack.pop()
    const a = stack.pop()
    if (a === undefined || b === undefined) throw new Error('Incomplete expression')
    switch ((tok as { v: string }).v) {
      case '+': stack.push(a + b); break
      case '-': stack.push(a - b); break
      case '*': stack.push(a * b); break
      case '/': if (b === 0) throw new Error('Divide by zero'); stack.push(a / b); break
      case '%': stack.push(a * (b / 100)); break
      case '^': stack.push(a ** b); break
    }
  }
  if (stack.length !== 1) throw new Error('Incomplete expression')
  return Math.round(stack[0] * 1e10) / 1e10
}

/** How many decimals a person actually wants to look at. */
const DP = 2

/*
 * Binary floating point cannot hold a tenth, so 0.1 + 0.2 comes out as
 * 0.30000000000000004 and a third of ten runs to sixteen digits. Neither is
 * information. Two decimals is what money has, and it is applied everywhere a
 * number is shown or handed on rather than only in the preview - otherwise
 * pressing equals put the full tail back into the input you were about to
 * reuse.
 */
export function tidy(n: number): number {
  if (!Number.isFinite(n)) return n
  return Math.round(n * 10 ** DP) / 10 ** DP
}

const show = (n: number) => tidy(n).toLocaleString('en-IN', { maximumFractionDigits: DP })

/**
 * Clear entry.
 *
 * AC wipes the line; CE takes back only what is currently being typed, which is
 * the correction people actually want after a mistyped digit halfway through a
 * long sum. It removes the trailing number literal, or if the expression ends
 * on an operator or bracket, that one character.
 */
export function clearEntry(expr: string): string {
  const trimmed = expr.replace(/\s+$/, '')
  if (!trimmed) return ''
  const trailingNumber = /[0-9.]+$/.exec(trimmed)
  if (trailingNumber) return trimmed.slice(0, trimmed.length - trailingNumber[0].length)
  return trimmed.slice(0, -1)
}

type Key = { k: string; kind: 'digit' | 'op' | 'clear' | 'equals' }

const KEYS: Key[] = [
  { k: 'AC', kind: 'clear' }, { k: 'CE', kind: 'clear' }, { k: '(', kind: 'op' }, { k: ')', kind: 'op' },
  { k: '%', kind: 'op' }, { k: '⌫', kind: 'op' }, { k: '^', kind: 'op' }, { k: '÷', kind: 'op' },
  { k: '7', kind: 'digit' }, { k: '8', kind: 'digit' }, { k: '9', kind: 'digit' }, { k: '×', kind: 'op' },
  { k: '4', kind: 'digit' }, { k: '5', kind: 'digit' }, { k: '6', kind: 'digit' }, { k: '−', kind: 'op' },
  { k: '1', kind: 'digit' }, { k: '2', kind: 'digit' }, { k: '3', kind: 'digit' }, { k: '+', kind: 'op' },
  { k: '0', kind: 'digit' }, { k: '00', kind: 'digit' }, { k: '.', kind: 'digit' }, { k: '=', kind: 'equals' },
]

const PANEL = { w: 272, h: 430 }
const POS_KEY = 'hisaabhkitaabh-calc-pos'

/** Keep the panel wholly on screen after a drag, a resize, or a stale saved position. */
function clamp(p: { x: number; y: number }): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - PANEL.w - 8)
  const maxY = Math.max(8, window.innerHeight - PANEL.h - 8)
  return { x: Math.min(Math.max(8, p.x), maxX), y: Math.min(Math.max(8, p.y), maxY) }
}

export function Calculator({ open, onClose, onUse }: { open: boolean; onClose: () => void; onUse?: (value: number) => void }) {
  const [expr, setExpr] = useState('')
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState('')
  const [tape, setTape] = useState<Array<{ expr: string; value: number }>>([])
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const dragFrom = useRef<{ dx: number; dy: number } | null>(null)

  /*
   * Closing runs the panel out rather than blinking it away. Everything that
   * can close it goes through here, so the escape key and the cross and the
   * "use value" button all leave the same way.
   */
  const dismiss = useCallback(() => {
    setLeaving(true)
    setTimeout(() => { setLeaving(false); onClose() }, 130)
  }, [onClose])

  // Restore where the user last parked it, then keep it inside the viewport.
  useEffect(() => {
    if (!open || pos) return
    let start: { x: number; y: number } | null = null
    try {
      const saved = localStorage.getItem(POS_KEY)
      if (saved) start = JSON.parse(saved) as { x: number; y: number }
    } catch { /* fall through to the default corner */ }
    setPos(clamp(start ?? { x: window.innerWidth - PANEL.w - 20, y: window.innerHeight - PANEL.h - 20 }))
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onResize = () => setPos((p) => (p ? clamp(p) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  useEffect(() => {
    if (!expr.trim()) { setResult(''); setError(''); return }
    try {
      const v = evaluate(expr)
      setResult(show(v))
      setError('')
    } catch (e) {
      setResult('')
      setError(e instanceof Error ? e.message : 'Invalid')
    }
  }, [expr])

  /**
   * What the copy button takes.
   *
   * The answer when there is one, because that is what a calculator is for.
   * The expression when there is not - a sum still being written, or one with
   * a syntax error in it, is often exactly the thing worth pasting elsewhere,
   * and refusing to copy it because it does not evaluate would be unhelpful.
   */
  const copy = useCallback(() => {
    const text = result ? result.replace(/,/g, '') : expr.trim()
    if (!text) return
    /*
     * The clipboard API needs a secure context, and where there is none it is
     * not a promise that rejects - the property is simply absent. Reaching it
     * through `?.` short-circuited the whole chain, `.catch` included, so the
     * fallback below could never run on the one kind of page that needed it.
     */
    const viaTextarea = () => {
      const area = document.createElement('textarea')
      area.value = text
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    if (!navigator.clipboard) { viaTextarea(); return }
    navigator.clipboard.writeText(text).catch(viaTextarea)
  }, [expr, result])

  const commit = useCallback(() => {
    if (!expr.trim()) return
    try {
      const v = tidy(evaluate(expr))
      setTape((t) => [{ expr, value: v }, ...t].slice(0, 8))
      setExpr(String(v))
    } catch { /* the inline error already says why */ }
  }, [expr])

  const press = useCallback((k: string) => {
    if (k === '=') return commit()
    if (k === 'AC') return setExpr('')
    if (k === 'CE') return setExpr(clearEntry)
    if (k === '⌫') return setExpr((e) => e.slice(0, -1))
    const mapped = k === '×' ? '*' : k === '÷' ? '/' : k === '−' ? '-' : k
    setExpr((e) => e + mapped)
  }, [commit])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return dismiss()
      if (e.key === 'Enter') { e.preventDefault(); return commit() }
      if (e.key === 'Backspace') { e.preventDefault(); return setExpr((v) => v.slice(0, -1)) }
      if (e.key === 'Delete') { e.preventDefault(); return setExpr(clearEntry) }
      if (/^[0-9+\-*/().%^]$/.test(e.key)) { e.preventDefault(); setExpr((v) => v + e.key) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismiss, commit])

  // Dragging is tracked on the window, not the handle, so a fast pointer that
  // outruns the panel does not drop the grab.
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const from = dragFrom.current
      if (!from) return
      setPos(clamp({ x: e.clientX - from.dx, y: e.clientY - from.dy }))
    }
    const up = () => {
      setDragging(false)
      dragFrom.current = null
      setPos((p) => {
        if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* not important enough to surface */ } }
        return p
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging])

  if (!open || !pos) return null

  return (
    <div
      /*
       * The entry animation is not conditional on dragging. It used to be, so
       * letting go of the panel re-added the class and replayed the whole
       * scale-in - which is the twitch you saw the moment you dropped it. A
       * class that never changes runs once, when the panel mounts.
       */
      className={`hidden sm:flex fixed z-50 card shadow-pop flex-col no-print select-none
                  ${leaving ? 'animate-scale-out' : 'animate-scale-in'}`}
      style={{ left: pos.x, top: pos.y, width: PANEL.w }}
      role="dialog"
      aria-label="Calculator"
    >
      <header
        onPointerDown={(e) => {
          if (e.button !== 0) return
          dragFrom.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
          setDragging(true)
        }}
        className={`flex items-center gap-1.5 px-2.5 h-10 border-b border-line rounded-t-xl2
                    ${dragging ? 'cursor-grabbing bg-raised' : 'cursor-grab hover:bg-raised/60'} transition-colors`}
        title="Drag to move"
      >
        <Icon.Grip size={14} className="text-faint" />
        <span className="text-[12px] font-medium text-muted flex items-center gap-1.5">Calculator</span>
        <button
          onClick={dismiss}
          onPointerDown={(e) => e.stopPropagation()}
          className="ml-auto text-faint hover:text-ink hover:bg-raised rounded p-1 -mr-0.5 transition-colors"
          aria-label="Close calculator"
        >
          <Icon.Close size={14} />
        </button>
      </header>

      {tape.length > 0 && (
        <div className="border-b border-line max-h-24 overflow-y-auto overscroll-contain">
          <div className="flex items-center justify-between px-2.5 pt-1.5">
            <span className="text-[10px] uppercase tracking-wide text-faint">Tape</span>
            <button onClick={() => setTape([])} className="text-[10.5px] text-faint hover:text-ink transition-colors">Clear</button>
          </div>
          <div className="px-2.5 pb-1.5 pt-1 space-y-0.5">
            {tape.map((t, i) => (
              <button
                key={i}
                onClick={() => setExpr(String(t.value))}
                className="w-full text-right text-[11px] text-faint hover:text-muted tnum block truncate"
                title={`${t.expr} = ${t.value}`}
              >
                {t.expr} = <span className="text-muted">{show(t.value)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-3 py-2.5 border-b border-line">
        <input
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder="0"
          aria-label="Expression"
          className="w-full bg-transparent text-right text-[19px] tnum outline-none placeholder:text-faint select-text"
        />
        {/* Copy sits in the corner of the display it copies from. What it takes
            is whatever is worth taking: the answer once there is one, and the
            expression itself while it is still being written - a half-typed
            sum is often exactly the thing you want to paste somewhere.

            The label does not change. It used to flip to COPIED for a beat and
            back, which is a button rewriting itself under the finger that just
            pressed it - motion in the corner of a panel whose whole job is to
            sit still while you read a number off it. The press is its own
            confirmation. */}
        <div className="flex items-end justify-between gap-2 mt-1 h-5">
          <button
            onClick={copy}
            disabled={!expr.trim()}
            aria-label="Copy"
            title={result ? `Copy ${result}` : 'Copy the expression'}
            className="text-[10px] font-medium tracking-wide px-1.5 h-5 rounded
                       border border-line text-faint hover:text-ink hover:bg-raised
                       disabled:opacity-0 transition-colors pressable"
          >
            COPY
          </button>
          <span className="text-[12px] tnum text-right min-w-0 truncate">
            {error ? <span className="text-bad">{error}</span> : <span className="text-muted">{result && `= ${result}`}</span>}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-px bg-line p-px">
        {KEYS.map(({ k, kind }) => (
          <button
            key={k}
            onClick={() => press(k)}
            className={`h-10 text-[14px] font-medium transition-colors ${
              kind === 'equals' ? 'bg-accent text-white hover:brightness-110'
              : kind === 'clear' ? 'bg-raised text-bad hover:bg-bad/10'
              : kind === 'digit' ? 'bg-surface hover:bg-raised'
              : 'bg-raised hover:bg-line text-muted'
            }`}
            title={k === 'AC' ? 'Clear everything' : k === 'CE' ? 'Clear the entry being typed' : undefined}
          >
            {k}
          </button>
        ))}
      </div>

      {onUse && (
        <footer className="p-2.5">
          <button
            className="btn-primary h-8 w-full text-[12px]"
            disabled={!result || Boolean(error)}
            onClick={() => { try { onUse(tidy(evaluate(expr))); dismiss() } catch { /* disabled when invalid */ } }}
          >
            Use value
          </button>
        </footer>
      )}
    </div>
  )
}

/** Launcher. Hidden on phones and on coarse-pointer devices. */
export function CalculatorButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Calculator"
      aria-label="Open calculator"
      className="hidden sm:flex fixed z-40 bottom-5 right-5 h-11 w-11 items-center justify-center
                 rounded-full bg-surface border border-line shadow-card text-muted
                 hover:text-ink hover:border-faint transition-colors no-print"
    >
      <Icon.Calculator size={19} />
    </button>
  )
}

export { evaluate as evaluateExpression }

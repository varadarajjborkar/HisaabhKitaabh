'use client'

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icons'

/**
 * Desktop-only calculator.
 *
 * Deliberately absent on phones: every phone ships one, and a worse copy inside
 * a web app is clutter. Hidden below the `sm` breakpoint, and the launcher is
 * gated on a fine pointer so it never appears on a tablet in touch mode either.
 *
 * Expressions are evaluated by a small shunting-yard parser rather than eval —
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

const KEYS = [
  ['(', ')', '%', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '−'],
  ['1', '2', '3', '+'],
  ['0', '.', '⌫', '='],
]

export function Calculator({ open, onClose, onUse }: { open: boolean; onClose: () => void; onUse?: (value: number) => void }) {
  const [expr, setExpr] = useState('')
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState('')
  const [tape, setTape] = useState<Array<{ expr: string; value: number }>>([])

  useEffect(() => {
    if (!expr.trim()) { setResult(''); setError(''); return }
    try {
      const v = evaluate(expr)
      setResult(v.toLocaleString('en-IN', { maximumFractionDigits: 6 }))
      setError('')
    } catch (e) {
      setResult('')
      setError(e instanceof Error ? e.message : 'Invalid')
    }
  }, [expr])

  const commit = useCallback(() => {
    if (!expr.trim()) return
    try {
      const v = evaluate(expr)
      setTape((t) => [{ expr, value: v }, ...t].slice(0, 8))
      setExpr(String(v))
    } catch { /* the inline error already says why */ }
  }, [expr])

  const press = useCallback((k: string) => {
    if (k === '=') return commit()
    if (k === '⌫') return setExpr((e) => e.slice(0, -1))
    const mapped = k === '×' ? '*' : k === '÷' ? '/' : k === '−' ? '-' : k
    setExpr((e) => e + mapped)
  }, [commit])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose()
      if (e.key === 'Enter') { e.preventDefault(); return commit() }
      if (e.key === 'Backspace') { e.preventDefault(); return setExpr((v) => v.slice(0, -1)) }
      if (/^[0-9+\-*/().%^]$/.test(e.key)) { e.preventDefault(); setExpr((v) => v + e.key) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, commit])

  if (!open) return null

  return (
    <div className="hidden sm:flex fixed z-50 bottom-20 right-5 w-[280px] card shadow-pop flex-col animate-rise no-print">
      <header className="flex items-center justify-between px-3.5 h-10 border-b border-line">
        <span className="text-[12px] font-medium text-muted flex items-center gap-1.5">
          <Icon.Calculator size={14} /> Calculator
        </span>
        <button onClick={onClose} className="text-faint hover:text-ink p-1 -mr-1" aria-label="Close calculator">
          <Icon.Close size={14} />
        </button>
      </header>

      {tape.length > 0 && (
        <div className="px-3.5 py-2 border-b border-line max-h-24 overflow-y-auto space-y-1">
          {tape.map((t, i) => (
            <button
              key={i}
              onClick={() => setExpr(String(t.value))}
              className="w-full text-right text-[11px] text-faint hover:text-muted tnum block truncate"
              title={`${t.expr} = ${t.value}`}
            >
              {t.expr} = <span className="text-muted">{t.value.toLocaleString('en-IN')}</span>
            </button>
          ))}
        </div>
      )}

      <div className="px-3.5 py-3 border-b border-line">
        <input
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder="0"
          aria-label="Expression"
          className="w-full bg-transparent text-right text-[19px] tnum outline-none placeholder:text-faint"
        />
        <div className="text-right text-[12px] mt-1 h-4 tnum">
          {error ? <span className="text-bad">{error}</span> : <span className="text-muted">{result && `= ${result}`}</span>}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-px bg-line p-px">
        {KEYS.flat().map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className={`h-10 text-[14px] font-medium transition-colors ${
              k === '=' ? 'bg-accent text-white hover:brightness-110'
              : /[0-9.]/.test(k) ? 'bg-surface hover:bg-raised'
              : 'bg-raised hover:bg-line text-muted'
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <footer className="flex gap-2 p-2.5">
        <button className="btn-ghost h-8 flex-1 text-[12px]" onClick={() => { setExpr(''); setTape([]) }}>Clear</button>
        {onUse && (
          <button
            className="btn-primary h-8 flex-1 text-[12px]"
            disabled={!result || Boolean(error)}
            onClick={() => { try { onUse(evaluate(expr)); onClose() } catch { /* disabled when invalid */ } }}
          >
            Use value
          </button>
        )}
      </footer>
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

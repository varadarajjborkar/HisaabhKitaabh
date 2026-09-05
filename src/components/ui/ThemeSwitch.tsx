'use client'

import { Icon } from './Icons'
import { useThemeMode, type ThemeMode } from '@/lib/client/useThemeMode'

const OPTIONS: Array<{ value: ThemeMode; label: string; icon: (p: { size?: number }) => React.ReactElement }> = [
  { value: 'light', label: 'Light', icon: Icon.Sun },
  { value: 'dark', label: 'Dark', icon: Icon.Moon },
  { value: 'system', label: 'System', icon: Icon.Monitor },
]

/**
 * Light, dark, or whatever the machine says.
 *
 * A segmented control rather than a two-state switch, because "follow the
 * system" is the default and a toggle cannot express it: flipping a switch back
 * and forth would leave the user pinned to an explicit choice with no way back.
 */
export function ThemeSwitch({ className = '' }: { className?: string }) {
  const [mode, setMode] = useThemeMode()

  return (
    <div
      className={`grid grid-cols-3 gap-1 p-1 rounded-lg bg-raised border border-line ${className}`}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, icon: Glyph }) => {
        const active = mode === value
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            onClick={() => setMode(value)}
            className={`flex flex-col items-center justify-center gap-1 h-[46px] rounded-md text-[10.5px]
                        transition-colors pressable ${
                          active
                            ? 'bg-surface text-accent shadow-sm border border-line'
                            : 'text-muted hover:text-ink hover:bg-surface/60 border border-transparent'
                        }`}
          >
            <Glyph size={15} />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The same preference as a single button, for surfaces with no account menu.
 *
 * Cycles light, dark, system, in that order, and names the *next* state in its
 * tooltip so the click is predictable rather than a guess.
 */
export function ThemeCycleButton({ className = '' }: { className?: string }) {
  const [mode, setMode] = useThemeMode()
  const next: ThemeMode = mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light'
  const Glyph = mode === 'light' ? Icon.Sun : mode === 'dark' ? Icon.Moon : Icon.Monitor

  return (
    <button
      onClick={() => setMode(next)}
      className={`h-9 w-9 grid place-items-center rounded-lg border border-line bg-surface/70 backdrop-blur
                  text-muted hover:text-ink hover:bg-raised transition-colors pressable ${className}`}
      title={`Theme: ${mode}. Switch to ${next}.`}
      aria-label={`Colour theme, currently ${mode}. Switch to ${next}.`}
    >
      <Glyph size={16} />
    </button>
  )
}

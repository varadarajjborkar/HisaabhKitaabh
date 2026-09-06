/**
 * Country dialling codes.
 *
 * A phone number without one is ambiguous the moment it leaves the country it
 * was typed in, and asking someone to remember whether their own code needs a
 * plus is a small indignity. The list is the codes with enough users to be
 * worth a row, India first because that is who this was built for.
 *
 * Stored as one string - "+91 98765 43210" - rather than as two fields,
 * because that is what a phone number is when it is written down, pasted into
 * a message, or dialled.
 */

export type Dial = { code: string; country: string; flag: string }

export const DIAL_CODES: Dial[] = [
  { code: '+91', country: 'India', flag: '🇮🇳' },
  { code: '+1', country: 'United States, Canada', flag: '🇺🇸' },
  { code: '+44', country: 'United Kingdom', flag: '🇬🇧' },
  { code: '+61', country: 'Australia', flag: '🇦🇺' },
  { code: '+65', country: 'Singapore', flag: '🇸🇬' },
  { code: '+971', country: 'United Arab Emirates', flag: '🇦🇪' },
  { code: '+966', country: 'Saudi Arabia', flag: '🇸🇦' },
  { code: '+974', country: 'Qatar', flag: '🇶🇦' },
  { code: '+973', country: 'Bahrain', flag: '🇧🇭' },
  { code: '+968', country: 'Oman', flag: '🇴🇲' },
  { code: '+60', country: 'Malaysia', flag: '🇲🇾' },
  { code: '+94', country: 'Sri Lanka', flag: '🇱🇰' },
  { code: '+977', country: 'Nepal', flag: '🇳🇵' },
  { code: '+880', country: 'Bangladesh', flag: '🇧🇩' },
  { code: '+92', country: 'Pakistan', flag: '🇵🇰' },
  { code: '+49', country: 'Germany', flag: '🇩🇪' },
  { code: '+33', country: 'France', flag: '🇫🇷' },
  { code: '+39', country: 'Italy', flag: '🇮🇹' },
  { code: '+34', country: 'Spain', flag: '🇪🇸' },
  { code: '+31', country: 'Netherlands', flag: '🇳🇱' },
  { code: '+41', country: 'Switzerland', flag: '🇨🇭' },
  { code: '+46', country: 'Sweden', flag: '🇸🇪' },
  { code: '+353', country: 'Ireland', flag: '🇮🇪' },
  { code: '+81', country: 'Japan', flag: '🇯🇵' },
  { code: '+82', country: 'South Korea', flag: '🇰🇷' },
  { code: '+86', country: 'China', flag: '🇨🇳' },
  { code: '+852', country: 'Hong Kong', flag: '🇭🇰' },
  { code: '+62', country: 'Indonesia', flag: '🇮🇩' },
  { code: '+63', country: 'Philippines', flag: '🇵🇭' },
  { code: '+66', country: 'Thailand', flag: '🇹🇭' },
  { code: '+84', country: 'Vietnam', flag: '🇻🇳' },
  { code: '+27', country: 'South Africa', flag: '🇿🇦' },
  { code: '+254', country: 'Kenya', flag: '🇰🇪' },
  { code: '+234', country: 'Nigeria', flag: '🇳🇬' },
  { code: '+20', country: 'Egypt', flag: '🇪🇬' },
  { code: '+90', country: 'Turkey', flag: '🇹🇷' },
  { code: '+7', country: 'Russia, Kazakhstan', flag: '🇷🇺' },
  { code: '+55', country: 'Brazil', flag: '🇧🇷' },
  { code: '+52', country: 'Mexico', flag: '🇲🇽' },
  { code: '+54', country: 'Argentina', flag: '🇦🇷' },
  { code: '+64', country: 'New Zealand', flag: '🇳🇿' },
]

export const DEFAULT_DIAL = '+91'

/**
 * Split a stored number into a code and the rest.
 *
 * Longest code first, so +971 is not read as +9 followed by 71. A number
 * stored before this existed has no code, and keeping it in the number field
 * rather than guessing one is the honest thing to do with it.
 */
export function splitDial(stored: string): { code: string; rest: string } {
  const text = (stored ?? '').trim()
  if (!text.startsWith('+')) return { code: DEFAULT_DIAL, rest: text }

  const codes = [...DIAL_CODES].sort((a, b) => b.code.length - a.code.length)
  for (const dial of codes) {
    if (text.startsWith(dial.code)) return { code: dial.code, rest: text.slice(dial.code.length).trim() }
  }
  return { code: DEFAULT_DIAL, rest: text }
}

/** Put them back together, or give nothing when there is no number. */
export function joinDial(code: string, rest: string): string {
  const digits = (rest ?? '').trim()
  return digits ? `${code} ${digits}` : ''
}

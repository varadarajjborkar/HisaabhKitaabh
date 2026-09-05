import { kv } from '../store/kv'

/**
 * Exchange rates.
 *
 * A file has one currency. People do not: a trip to Dubai produces receipts in
 * dirhams, a subscription bills in dollars, and both belong in the same ledger
 * as everything else. Without a rate, the assistant can only ask the user what
 * the rate is - which is asking them to go and look it up, in a tool whose
 * entire job is to save them that.
 *
 * Two keyless sources, in order:
 *
 *   1. Frankfurter, which republishes the European Central Bank's daily
 *      reference rates. Authoritative, dated, and honest about which day it is
 *      quoting - but it only covers the ~30 currencies the ECB publishes.
 *   2. open.er-api.com, which covers about 160. This is what answers for the
 *      dirham, the riyal and the rupee's neighbours, none of which the ECB
 *      quotes and all of which matter to somebody tracking expenses from here.
 *
 * Rates are cached for six hours. Both sources update once a day, so a fresher
 * fetch would return the same number and cost a round trip to do it.
 */

export type Rate = {
  from: string
  to: string
  rate: number
  /** The day the rate is for, not the day we fetched it. */
  asOf: string
  source: string
}

const CACHE_SECONDS = 6 * 60 * 60
const TIMEOUT_MS = 6000

/**
 * What people actually type. A symbol, a code, or the name of the thing.
 *
 * "$" is deliberately USD even though five other currencies use that sign: a
 * user who means Singapore dollars writes SGD, and one who writes "$" and gets
 * Canadian dollars would be astonished. The conversion is shown for approval
 * before anything is written, so a wrong guess is visible rather than silent.
 */
const ALIASES: Record<string, string> = {
  '$': 'USD', 'us$': 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD', 'u.s. dollar': 'USD',
  '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '£': 'GBP', gbp: 'GBP', pound: 'GBP', pounds: 'GBP', sterling: 'GBP', quid: 'GBP',
  '¥': 'JPY', jpy: 'JPY', yen: 'JPY',
  '₹': 'INR', inr: 'INR', rupee: 'INR', rupees: 'INR', rs: 'INR', 'rs.': 'INR',
  'د.إ': 'AED', aed: 'AED', dirham: 'AED', dirhams: 'AED',
  sar: 'SAR', riyal: 'SAR', riyals: 'SAR',
  qar: 'QAR', kwd: 'KWD', bhd: 'BHD', omr: 'OMR',
  sgd: 'SGD', 'sg$': 'SGD',
  aud: 'AUD', 'a$': 'AUD', cad: 'CAD', 'c$': 'CAD', nzd: 'NZD',
  chf: 'CHF', franc: 'CHF', francs: 'CHF',
  cny: 'CNY', rmb: 'CNY', yuan: 'CNY', '¥cny': 'CNY',
  hkd: 'HKD', krw: 'KRW', won: 'KRW',
  thb: 'THB', baht: 'THB', myr: 'MYR', ringgit: 'MYR',
  idr: 'IDR', rupiah: 'IDR', php: 'PHP', vnd: 'VND',
  lkr: 'LKR', npr: 'NPR', pkr: 'PKR', bdt: 'BDT', btn: 'BTN', mvr: 'MVR',
  zar: 'ZAR', rand: 'ZAR', brl: 'BRL', mxn: 'MXN', rub: 'RUB', try: 'TRY', lira: 'TRY',
  sek: 'SEK', nok: 'NOK', dkk: 'DKK', pln: 'PLN', czk: 'CZK', huf: 'HUF', ils: 'ILS',
}

/** Turn whatever the user wrote into an ISO 4217 code, or null. */
export function currencyCode(input: string): string | null {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return null
  const direct = ALIASES[raw]
  if (direct) return direct
  // Strip anything that is not a letter and try again: "890 USD", "USD.", "usd$"
  const letters = raw.replace(/[^a-z]/g, '')
  if (ALIASES[letters]) return ALIASES[letters]
  return /^[a-z]{3}$/.test(letters) ? letters.toUpperCase() : null
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`)
  return res.json()
}

async function fromFrankfurter(from: string, to: string): Promise<Rate | null> {
  const data = (await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`)) as {
    date?: string
    rates?: Record<string, number>
  }
  const rate = data.rates?.[to]
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null
  return { from, to, rate, asOf: data.date ?? new Date().toISOString().slice(0, 10), source: 'European Central Bank' }
}

async function fromOpenErApi(from: string, to: string): Promise<Rate | null> {
  const data = (await fetchJson(`https://open.er-api.com/v6/latest/${from}`)) as {
    result?: string
    time_last_update_utc?: string
    rates?: Record<string, number>
  }
  if (data.result !== 'success') return null
  const rate = data.rates?.[to]
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null
  const asOf = data.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
  return { from, to, rate, asOf, source: 'open.er-api.com' }
}

export class RateUnavailableError extends Error {
  constructor(from: string, to: string) {
    super(`No published rate for ${from} to ${to} right now. Give me the rate to use and I will apply it.`)
    this.name = 'RateUnavailableError'
  }
}

/** Today's rate for one pair, cached. Throws only when both sources fail. */
export async function rateFor(fromInput: string, toInput: string): Promise<Rate> {
  const from = currencyCode(fromInput)
  const to = currencyCode(toInput)
  if (!from) throw new Error(`"${fromInput}" is not a currency I recognise. Use a three-letter code like USD.`)
  if (!to) throw new Error(`"${toInput}" is not a currency I recognise. Use a three-letter code like INR.`)
  if (from === to) return { from, to, rate: 1, asOf: new Date().toISOString().slice(0, 10), source: 'same currency' }

  const key = `fx:${from}:${to}`
  const cached = await kv().get<Rate>(key)
  if (cached) return cached

  const errors: string[] = []
  for (const lookup of [fromFrankfurter, fromOpenErApi]) {
    try {
      const rate = await lookup(from, to)
      if (rate) {
        await kv().set(key, rate, { ex: CACHE_SECONDS })
        return rate
      }
    } catch (err) {
      errors.push((err as Error).message)
    }
  }
  if (errors.length) console.warn('[hisaabhkitaabh] rate lookup failed:', errors.join('; '))
  throw new RateUnavailableError(from, to)
}

export type Converted = { amount: number; rate: Rate; original: number }

export async function convertAmount(amount: number, from: string, to: string): Promise<Converted> {
  const rate = await rateFor(from, to)
  return { amount: Math.round(amount * rate.rate * 100) / 100, rate, original: amount }
}

/**
 * How a conversion reads in a row and in an approval card.
 *
 * The rate and its date go in, because in six months "why is this row 84,096"
 * is a question the file itself should be able to answer.
 */
export function describeConversion(c: Converted): string {
  return `${c.original.toLocaleString('en-IN')} ${c.rate.from} at ${c.rate.rate} on ${c.rate.asOf}`
}

export function describeRate(rate: Rate): string {
  return `1 ${rate.from} = ${rate.rate} ${rate.to} (${rate.source}, ${rate.asOf})`
}

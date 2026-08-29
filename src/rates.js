/**
 * The pinned, dated rate table and the exact arithmetic that prices a receipt
 * line against it.
 *
 * Three properties matter more than coverage here:
 *
 * 1. **Pinned and dated.** Prices move. A receipt that says "$0.0041" without
 *    saying *which* table produced it is not citable, so the table carries an
 *    as-of date and a source, and every receipt line records the table id and
 *    the tier it was priced under.
 * 2. **Exact.** Rates are stored as integer nano-USD per token, never as
 *    floats, so a line's cost and a run's total are computed by integer
 *    arithmetic and converted to USD exactly once at the edge. Summing
 *    thousands of `1.32e-6`s in binary floating point drifts; summing integers
 *    does not.
 * 3. **Time-aware.** DeepSeek charges the standard rate only during fixed
 *    weekday UTC windows and half that at every other hour, so the price of a
 *    call depends on both the time and the day it happened. A usage event with
 *    no timestamp therefore cannot be priced at all — see {@link tierAt} —
 *    rather than being quietly billed at one tier or the other.
 *
 * A model outside the table is not guessed at either: {@link priceNanoUsd}
 * returns `null` and the caller records the tokens with a null cost.
 * @module dsh-spend-receipt/rates
 */

/** The currency every `usd` field in this package is denominated in. */
export const CURRENCY = 'USD'

/**
 * Identifier stamped on every receipt line priced under this table.
 *
 * Bump the date when the rates below change so old lines stay attributable to
 * the numbers that actually produced them.
 */
export const RATE_TABLE_ID = 'deepseek-v4@2026-08-29'

/** The as-of date of {@link RATE_TABLE}, ISO-8601 (YYYY-MM-DD). */
export const RATE_TABLE_DATE = '2026-08-29'

/** Where the rates were read from, recorded so a reader can re-check them. */
export const RATE_TABLE_SOURCE = Object.freeze({
  publisher: 'DeepSeek',
  url: 'https://api-docs.deepseek.com/quick_start/pricing',
  captured: '2026-08-29',
})

/**
 * When the standard (peak) rate applies, in UTC.
 *
 * DeepSeek prices calls at the standard rate during two weekday windows —
 * **01:00–04:00 and 06:00–10:00 UTC, Monday through Friday** — and at half that
 * rate at every other hour. Peak is therefore the *narrow* case: the gap
 * between the two windows, every evening and night, and the whole of Saturday
 * and Sunday are all off-peak.
 *
 * Windows are half-open, `[start, end)`: 04:00:00 is already off-peak. Days are
 * `Date#getUTCDay` numbers, so 1–5 is Monday to Friday.
 */
export const PEAK_SCHEDULE_UTC = Object.freeze({
  days: Object.freeze([1, 2, 3, 4, 5]),
  windows: Object.freeze([
    Object.freeze({ start_minute: 1 * 60, end_minute: 4 * 60 }),
    Object.freeze({ start_minute: 6 * 60, end_minute: 10 * 60 }),
  ]),
  label: '01:00–04:00 and 06:00–10:00 UTC, Mon–Fri',
})

/** The two tiers a call can be billed at. */
export const TIERS = Object.freeze({ PEAK: 'peak', OFF_PEAK: 'off-peak' })

/**
 * Nano-USD (1e-9 USD) per token, per model, per tier.
 *
 * `input_cache_miss` prices prompt tokens the cache did not serve;
 * `input_cache_hit` prices the ones it did. DeepSeek bills the two at very
 * different rates, which is the whole reason a receipt has to carry
 * `cache_hit_tokens` separately rather than one prompt-token count.
 *
 * As of {@link RATE_TABLE_DATE}, in USD per 1M tokens — off-peak is exactly
 * half of peak, but is written out rather than derived so the shipped numbers
 * are the ones a reader can check against the price list. See
 * {@link PEAK_SCHEDULE_UTC} for which hours are billed at which tier:
 *
 * | model             | tier     | cache hit | cache miss | output |
 * |-------------------|----------|-----------|------------|--------|
 * | deepseek-v4-pro   | peak     | $0.044    | $1.32      | $3.96  |
 * | deepseek-v4-pro   | off-peak | $0.022    | $0.66      | $1.98  |
 * | deepseek-v4-flash | peak     | $0.014    | $0.44      | $1.32  |
 * | deepseek-v4-flash | off-peak | $0.007    | $0.22      | $0.66  |
 */
export const RATE_TABLE = Object.freeze({
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ input_cache_hit: 44, input_cache_miss: 1320, output: 3960 }),
    'off-peak': Object.freeze({ input_cache_hit: 22, input_cache_miss: 660, output: 1980 }),
  }),
  'deepseek-v4-flash': Object.freeze({
    peak: Object.freeze({ input_cache_hit: 14, input_cache_miss: 440, output: 1320 }),
    'off-peak': Object.freeze({ input_cache_hit: 7, input_cache_miss: 220, output: 660 }),
  }),
})

/**
 * Aliases accepted for the models in {@link RATE_TABLE}.
 *
 * Only spellings of the *same* model belong here — a provider prefix, or the
 * `-latest` pointer for an id already in the table. Mapping a near neighbour
 * onto a priced row would invent a price, which is exactly what this package
 * must not do.
 */
export const MODEL_ALIASES = Object.freeze({
  'deepseek/deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek/deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-pro-latest': 'deepseek-v4-pro',
  'deepseek-v4-flash-latest': 'deepseek-v4-flash',
})

/**
 * Resolve a model string to its key in {@link RATE_TABLE}.
 * @param model - The model name as it appeared in the usage event.
 * @returns The canonical key, or `null` if the model is not in the table.
 */
export function canonicalModel(model) {
  if (typeof model !== 'string') return null
  const trimmed = model.trim()
  if (Object.hasOwn(RATE_TABLE, trimmed)) return trimmed
  return Object.hasOwn(MODEL_ALIASES, trimmed) ? MODEL_ALIASES[trimmed] : null
}

/**
 * Which tier an instant falls in.
 *
 * Peak is the exception, so the test asks whether the instant is inside the
 * schedule and calls everything else off-peak — a weekend hour that would be
 * peak on a Tuesday is off-peak, and so is 05:00 on that Tuesday. A timestamp
 * that is absent or unparseable yields `null`: the tier is unknown, and an
 * unknown tier must not silently become either of the real ones.
 * @param ts - An ISO-8601 instant.
 * @returns `'peak'`, `'off-peak'`, or `null` if the instant is unusable.
 */
export function tierAt(ts) {
  if (typeof ts !== 'string' || ts.trim() === '') return null
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return null

  if (!PEAK_SCHEDULE_UTC.days.includes(date.getUTCDay())) return TIERS.OFF_PEAK

  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  const inPeakWindow = PEAK_SCHEDULE_UTC.windows.some(
    (window) => minute >= window.start_minute && minute < window.end_minute,
  )
  return inPeakWindow ? TIERS.PEAK : TIERS.OFF_PEAK
}

/**
 * Look up a model's rates for one tier.
 * @param model - The model name as it appeared in the usage event.
 * @param tier - `'peak'` or `'off-peak'`.
 * @returns The nano-USD-per-token rates, or `null` for an unpriced model or unknown tier.
 */
export function rateFor(model, tier) {
  const key = canonicalModel(model)
  if (key === null || (tier !== TIERS.PEAK && tier !== TIERS.OFF_PEAK)) return null
  return RATE_TABLE[key][tier]
}

/**
 * Price one usage record in whole nano-USD.
 *
 * `input_tokens` is the total prompt tokens billed, of which
 * `cache_hit_tokens` were served from cache; the remainder is billed at the
 * cache-miss rate. Counts are taken as given — nothing here estimates a
 * missing one.
 * @param model - The model name as it appeared in the usage event.
 * @param tokens - `{ input_tokens, cache_hit_tokens, output_tokens }`, all non-negative integers.
 * @param tier - The billing tier, from {@link tierAt}.
 * @returns Integer nano-USD, or `null` if the model or tier is not in the rate table.
 * @throws {RangeError} If the counts are not non-negative integers, or more tokens hit the cache than were sent.
 */
export function priceNanoUsd(model, tokens, tier) {
  const input = requireCount(tokens?.input_tokens, 'input_tokens')
  const hit = requireCount(tokens?.cache_hit_tokens, 'cache_hit_tokens')
  const output = requireCount(tokens?.output_tokens, 'output_tokens')
  if (hit > input) {
    throw new RangeError(
      `cache_hit_tokens (${hit}) exceeds input_tokens (${input}); refusing to price an impossible split`,
    )
  }

  const rates = rateFor(model, tier)
  if (rates === null) return null

  const miss = input - hit
  return miss * rates.input_cache_miss + hit * rates.input_cache_hit + output * rates.output
}

/**
 * Convert exact nano-USD to the USD number written to a receipt line.
 *
 * Nine decimal places is the full precision of the input, so the rounding is
 * presentational rather than a loss of the underlying integer — which is why
 * the integer is kept alongside it on every line.
 * @param nanoUsd - Integer nano-USD, or `null` for an unpriced line.
 * @returns USD as a number, or `null`.
 */
export function nanoUsdToUsd(nanoUsd) {
  if (nanoUsd === null) return null
  return Number((nanoUsd / 1e9).toFixed(9))
}

/**
 * The table as a plain, serialisable value — what the tool and CLI report.
 * @returns The table id, date, currency, source, peak schedule, and per-model
 *   USD-per-1M-token rates for both tiers.
 */
export function describeRateTable() {
  const perMillion = (nano) => Number(((nano * 1e6) / 1e9).toFixed(9))
  const tierRates = (rates) => ({
    input_cache_hit_usd_per_1m: perMillion(rates.input_cache_hit),
    input_cache_miss_usd_per_1m: perMillion(rates.input_cache_miss),
    output_usd_per_1m: perMillion(rates.output),
  })

  return {
    id: RATE_TABLE_ID,
    date: RATE_TABLE_DATE,
    currency: CURRENCY,
    source: { ...RATE_TABLE_SOURCE },
    peak_schedule_utc: PEAK_SCHEDULE_UTC.label,
    models: Object.fromEntries(
      Object.entries(RATE_TABLE).map(([model, tiers]) => [
        model,
        { peak: tierRates(tiers.peak), 'off-peak': tierRates(tiers['off-peak']) },
      ]),
    ),
  }
}

/**
 * @param value - The candidate count.
 * @param field - Field name, for the error message.
 * @returns The value, once it is known to be a non-negative integer.
 */
function requireCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return value
}

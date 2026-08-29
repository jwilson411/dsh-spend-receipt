/**
 * Reporting over a receipt: the last N lines, the totals behind them, and the
 * cache-hit rate.
 *
 * Totals are summed from each line's exact integer `nano_usd` and converted to
 * USD once, so a thousand-line receipt adds up to the same number a
 * spreadsheet would get. Unpriced lines — an unknown model, or a prompt whose
 * cache split the provider never reported — contribute their tokens and are
 * counted separately, never a zero folded silently into the money.
 * @module dsh-spend-receipt/summary
 */
import { CURRENCY, nanoUsdToUsd } from './rates.js'

/** How many lines a report returns when the caller does not say. */
export const DEFAULT_LIMIT = 20

/**
 * Summarise a receipt.
 *
 * Two scopes are reported because they answer different questions: `totals` and
 * `cache_hit_rate` cover the whole receipt ("what has this cost?"), while
 * `window_totals` and `window_cache_hit_rate` cover only the returned lines
 * ("what did the last few calls cost?").
 * @param allLines - Every parsed receipt line, in file order.
 * @param options - `limit`, the number of trailing lines to return (default {@link DEFAULT_LIMIT}).
 * @returns The window of lines and both scopes of totals.
 */
export function summarize(allLines, options = {}) {
  const limit = normalizeLimit(options.limit)
  const window = limit >= allLines.length ? [...allLines] : allLines.slice(allLines.length - limit)

  return {
    lines: window,
    returned: window.length,
    total_lines: allLines.length,
    totals: totalsOf(allLines),
    cache_hit_rate: cacheHitRate(allLines),
    window_totals: totalsOf(window),
    window_cache_hit_rate: cacheHitRate(window),
  }
}

/**
 * Sum a set of receipt lines.
 * @param lines - Receipt lines.
 * @returns Token totals, the USD total with its exact nano-USD counterpart, and
 *   the priced/unpriced line split. `usd` covers the priced lines only.
 */
export function totalsOf(lines) {
  let inputTokens = 0
  let cacheHitTokens = 0
  let outputTokens = 0
  let nanoUsd = 0
  let priced = 0
  let unpriced = 0

  for (const line of lines) {
    inputTokens += count(line.input_tokens)
    cacheHitTokens += count(line.cache_hit_tokens)
    outputTokens += count(line.output_tokens)

    const nano = nanoOf(line)
    if (nano === null) unpriced += 1
    else {
      priced += 1
      nanoUsd += nano
    }
  }

  return {
    lines: lines.length,
    priced_lines: priced,
    unpriced_lines: unpriced,
    input_tokens: inputTokens,
    cache_hit_tokens: cacheHitTokens,
    output_tokens: outputTokens,
    usd: nanoUsdToUsd(nanoUsd),
    nano_usd: nanoUsd,
    currency: CURRENCY,
  }
}

/**
 * The share of billed prompt tokens the cache served.
 *
 * Lines whose cache split is unknown are excluded from *both* halves of the
 * ratio rather than counted as misses — an unknown split must not be allowed to
 * quietly drag the rate down. `basis` says how much of the receipt the rate was
 * actually computed over.
 * @param lines - Receipt lines.
 * @returns `{ rate, basis }`, where `rate` is `null` when no line has a known
 *   split or those lines billed no prompt tokens at all.
 */
export function cacheHitRate(lines) {
  let inputTokens = 0
  let cacheHitTokens = 0
  let known = 0

  for (const line of lines) {
    if (typeof line.cache_hit_tokens !== 'number') continue
    known += 1
    inputTokens += count(line.input_tokens)
    cacheHitTokens += count(line.cache_hit_tokens)
  }

  return {
    rate: inputTokens === 0 ? null : Number((cacheHitTokens / inputTokens).toFixed(6)),
    basis: {
      lines_with_known_split: known,
      lines_with_unknown_split: lines.length - known,
      input_tokens: inputTokens,
      cache_hit_tokens: cacheHitTokens,
    },
  }
}

/**
 * A line's cost in exact nano-USD.
 *
 * `nano_usd` is the exact field; a line written by some other producer may
 * carry only `usd`, in which case it is scaled back up and rounded — the same
 * value to the precision `usd` was written at.
 * @param line - A receipt line.
 * @returns Integer nano-USD, or `null` if the line is unpriced.
 */
function nanoOf(line) {
  if (Number.isFinite(line.nano_usd)) return Math.round(line.nano_usd)
  if (Number.isFinite(line.usd)) return Math.round(line.usd * 1e9)
  return null
}

/**
 * @param value - A candidate token count from a receipt line.
 * @returns The count, or 0 if it is absent or unknown.
 */
function count(value) {
  return Number.isFinite(value) ? value : 0
}

/**
 * @param limit - The requested line count.
 * @returns A positive integer limit, defaulting when unset.
 * @throws {RangeError} If a limit is given but is not a positive integer.
 */
function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${JSON.stringify(limit)}`)
  }
  return limit
}

/**
 * The receipt itself: building lines, appending them, reading them back, and
 * deriving them from an append-only session log.
 *
 * A receipt is a JSONL file that is only ever appended to. Nothing in this
 * module rewrites, reorders, or truncates it, so an existing line's bytes are
 * the same bytes tomorrow — that is what makes a line quotable. Each line
 * carries the counts as reported, the rate table it was priced under, and the
 * source it was derived from, which together are enough for a reader to
 * re-derive the number without trusting this package.
 *
 * Deriving from a session log is resumable and idempotent: the cursor is not
 * separate state but the highest source line already present in the receipt, so
 * re-running a sync over a growing log appends only what is new.
 * @module dsh-spend-receipt/receipt
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { CURRENCY, RATE_TABLE_ID, canonicalModel, nanoUsdToUsd, priceNanoUsd, tierAt } from './rates.js'
import { SKIP_REASONS, normalizeUsageEvent } from './usage.js'

/** Why a line carries `usd: null` rather than a cost. */
export const UNPRICED_REASONS = Object.freeze({
  MODEL_NOT_IN_RATE_TABLE: 'model-not-in-rate-table',
  CACHE_SPLIT_UNKNOWN: 'cache-split-unknown',
  TIMESTAMP_UNKNOWN: 'timestamp-unknown',
})

/** A session-log line that was not JSON at all. */
export const UNPARSEABLE_JSON = 'unparseable-json'

/**
 * Build one receipt line from normalised usage.
 *
 * Pricing is total refusal or total confidence. Three things can withhold a
 * price, each recorded as a reason: a model outside the rate table, a prompt
 * whose cache split the provider never reported, and an instant that cannot be
 * placed in the peak/off-peak schedule. The tokens are still recorded — they
 * were measured — and only the money is withheld.
 * @param usage - A `usage` object from {@link normalizeUsageEvent}.
 * @param source - Provenance for the line, e.g. `{ kind: 'session-log', path, line }`.
 * @returns The receipt line, ready to serialise.
 */
export function receiptLineFor(usage, source = null) {
  const tier = tierAt(usage.ts)
  const splitKnown = usage.cache_hit_tokens !== null
  const modelKnown = canonicalModel(usage.model) !== null
  const nanoUsd =
    splitKnown && modelKnown && tier !== null
      ? priceNanoUsd(
          usage.model,
          {
            input_tokens: usage.input_tokens,
            cache_hit_tokens: usage.cache_hit_tokens,
            output_tokens: usage.output_tokens,
          },
          tier,
        )
      : null

  const line = {
    ts: usage.ts,
    session_id: usage.session_id,
    model: usage.model,
    input_tokens: usage.input_tokens,
    cache_hit_tokens: usage.cache_hit_tokens,
    output_tokens: usage.output_tokens,
    usd: nanoUsdToUsd(nanoUsd),
    currency: CURRENCY,
    // Exact integer nano-USD (1e-9 USD) behind `usd`. Totals are summed from
    // this field so a long receipt adds up without floating-point drift.
    nano_usd: nanoUsd,
    rate_table: RATE_TABLE_ID,
    rate_tier: tier,
    ts_source: usage.ts_source,
  }
  if (nanoUsd === null) {
    line.unpriced_reason = !splitKnown
      ? UNPRICED_REASONS.CACHE_SPLIT_UNKNOWN
      : tier === null
        ? UNPRICED_REASONS.TIMESTAMP_UNKNOWN
        : UNPRICED_REASONS.MODEL_NOT_IN_RATE_TABLE
  }
  if (source !== null) line.source = source
  return line
}

/**
 * Append receipt lines to a JSONL file, creating it and its directory if needed.
 *
 * The batch is serialised once and written in a single append so a crash cannot
 * interleave a half-written line between two whole ones.
 * @param receiptPath - Path to the receipt file.
 * @param lines - Receipt line objects.
 * @returns The number of lines appended.
 */
export function appendReceiptLines(receiptPath, lines) {
  if (lines.length === 0) return 0
  const target = resolve(receiptPath)
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return lines.length
}

/**
 * Read a receipt back.
 *
 * A missing file is an empty receipt, not an error — nothing has been spent
 * yet. A line that does not parse is counted rather than thrown, so one corrupt
 * line cannot make the rest of the history unreadable.
 * @param receiptPath - Path to the receipt file.
 * @returns `{ lines, malformed }` — parsed lines in file order, and the 1-based
 *   numbers of lines that did not parse.
 */
export function readReceiptLines(receiptPath) {
  const text = readFileIfPresent(resolve(receiptPath))
  if (text === null) return { lines: [], malformed: [] }

  const lines = []
  const malformed = []
  for (const { value, number } of jsonlEntries(text)) {
    if (value === undefined) malformed.push(number)
    else lines.push(value)
  }
  return { lines, malformed }
}

/**
 * Record one usage event, appending a receipt line if it yields one.
 *
 * This is the entry point for a host that already has a usage hook of its own:
 * hand it the event, and it decides whether the event is recordable.
 * @param event - A raw usage event.
 * @param options - `receiptPath`, plus optional `sessionId`, `recordedAt`, and `source`.
 * @returns `{ recorded }` with the appended line, or `{ skipped }` with the reason it produced none.
 */
export function recordUsage(event, options) {
  const { receiptPath, sessionId, recordedAt = new Date().toISOString(), source = null } = options
  const result = normalizeUsageEvent(event, { sessionId, recordedAt })
  if (!result.ok) return { recorded: null, skipped: result.reason }

  const line = receiptLineFor(result.usage, source)
  appendReceiptLines(receiptPath, [line])
  return { recorded: line, skipped: null }
}

/**
 * Derive receipt lines from an append-only session log, resuming where the
 * receipt left off.
 *
 * The log is read as JSONL. Lines that carry usage become receipt lines; lines
 * that carry only a session id (a session header, say) set the session for the
 * lines that follow, which is how usage events that name no session still get
 * attributed. Everything else is ignored.
 *
 * Resumption uses the receipt's own contents: the highest `source.line` already
 * recorded against this log path is the cursor. That holds as long as the log
 * is genuinely append-only — a rewritten log would need a fresh receipt.
 * @param options - `logPath`, `receiptPath`, optional `sessionId` fallback and `recordedAt`.
 * @returns `{ appended, lines, skipped, cursor, scanned }` — how many lines were
 *   appended, the appended lines themselves, `{ line, reason }` for each log line
 *   that carried usage-shaped data but produced nothing, the new cursor, and how
 *   many log lines were examined this run.
 */
export function syncFromSessionLog(options) {
  const {
    logPath,
    receiptPath,
    sessionId: fallbackSessionId,
    recordedAt = new Date().toISOString(),
  } = options
  const sourcePath = resolve(logPath)
  const text = readFileIfPresent(sourcePath)
  if (text === null) {
    throw new Error(`session log not found: ${sourcePath}`)
  }

  const cursor = lastRecordedLine(receiptPath, sourcePath)
  const pending = []
  const skipped = []
  let scanned = 0
  let currentSession = null

  for (const { value, number } of jsonlEntries(text)) {
    if (number <= cursor) {
      // Still track session headers below the cursor, so a resumed run
      // attributes later events to the session the log actually declared.
      if (value !== undefined) currentSession = sessionOf(value) ?? currentSession
      continue
    }
    scanned += 1

    if (value === undefined) {
      skipped.push({ line: number, reason: UNPARSEABLE_JSON })
      continue
    }

    const declared = sessionOf(value)
    const result = normalizeUsageEvent(value, {
      sessionId: declared ?? currentSession ?? fallbackSessionId,
      recordedAt,
    })
    if (declared !== null) currentSession = declared

    if (!result.ok) {
      // Only complain about lines that looked like usage; a log is full of
      // messages and tool calls that were never meant to be priced.
      if (
        result.reason !== SKIP_REASONS.NO_USAGE_PAYLOAD &&
        result.reason !== SKIP_REASONS.NOT_AN_OBJECT
      ) {
        const skip = { line: number, reason: result.reason }
        if (result.field !== undefined) skip.field = result.field
        skipped.push(skip)
      }
      continue
    }

    pending.push(
      receiptLineFor(result.usage, { kind: 'session-log', path: sourcePath, line: number }),
    )
  }

  appendReceiptLines(receiptPath, pending)
  const newCursor = pending.length > 0 ? pending.at(-1).source.line : cursor
  return { appended: pending.length, lines: pending, skipped, cursor: newCursor, scanned }
}

/**
 * The highest source line already recorded against a given log.
 * @param receiptPath - Path to the receipt file.
 * @param sourcePath - Absolute path of the session log.
 * @returns The cursor, or 0 if this log has contributed nothing yet.
 */
export function lastRecordedLine(receiptPath, sourcePath) {
  const { lines } = readReceiptLines(receiptPath)
  let cursor = 0
  for (const line of lines) {
    if (line?.source?.kind !== 'session-log') continue
    if (resolve(String(line.source.path ?? '')) !== resolve(sourcePath)) continue
    if (Number.isSafeInteger(line.source.line) && line.source.line > cursor) {
      cursor = line.source.line
    }
  }
  return cursor
}

/**
 * @param path - Absolute path.
 * @returns The file's text, or `null` if it does not exist.
 */
function readFileIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Walk JSONL text, yielding one entry per non-blank line.
 * @param text - The file contents.
 * @yields `{ value, number }`, where `value` is `undefined` for a line that did not parse.
 */
function* jsonlEntries(text) {
  const rows = text.split('\n')
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].trim()
    if (row === '') continue
    let value
    try {
      value = JSON.parse(row)
    } catch {
      value = undefined
    }
    yield { value, number: index + 1 }
  }
}

/**
 * @param value - A parsed log line.
 * @returns The session id it declares, or `null`.
 */
function sessionOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  for (const key of ['session_id', 'sessionId']) {
    if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim()
  }
  return null
}

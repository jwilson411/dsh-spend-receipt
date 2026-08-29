/**
 * The receipt: what a line says, that the file only ever grows, and that a
 * second sweep of a growing log picks up exactly what is new.
 *
 * Every case runs against the checked-in session-log fixture and a scratch
 * receipt in a temporary directory. No profile boots, no socket opens, and no
 * clock is consulted — `recordedAt` is always passed in, so a line whose event
 * carried no timestamp is still deterministic.
 */
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  UNPARSEABLE_JSON,
  UNPRICED_REASONS,
  appendReceiptLines,
  lastRecordedLine,
  readReceiptLines,
  receiptLineFor,
  recordUsage,
  syncFromSessionLog,
} from '../src/receipt.js'
import { SKIP_REASONS } from '../src/usage.js'

/** The checked-in session log every sweep in this file reads. */
const SESSION_FIXTURE = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))

/** One more usage line, appended to a copy of the fixture to test resumption. */
const APPENDED_FIXTURE = fileURLToPath(new URL('./fixtures/session-appended.jsonl', import.meta.url))

/**
 * The instant stamped on events that carry none, so `ts_source: 'recorded'` is
 * testable. A Friday inside the 06:00–10:00 UTC peak window, so such a line is
 * priced at the peak rate like any other.
 */
const RECORDED_AT = '2026-08-28T09:00:00.000Z'

const scratchDirs = []

/**
 * A fresh temporary directory, removed when the file's tests finish.
 * @returns The directory path.
 */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spend-receipt-'))
  scratchDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

test('a sweep of the session log records every usage event and nothing else', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')

  const result = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })

  assert.equal(result.appended, 6)
  assert.equal(result.scanned, 12)
  assert.equal(result.cursor, 12)
  assert.deepEqual(
    result.lines.map((line) => line.source.line),
    [3, 5, 7, 8, 11, 12],
  )
})

test('a recorded line states the counts, the price, and the table it was priced under', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const { lines } = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })

  // Friday 02:00Z, inside the first peak window:
  // 3000 miss × 1320 + 9000 hit × 44 + 800 out × 3960 = 7,524,000 nano-USD.
  assert.deepEqual(lines[0], {
    ts: '2026-08-28T02:00:12.000Z',
    session_id: 'sess-7c2',
    model: 'deepseek-v4-pro',
    input_tokens: 12000,
    cache_hit_tokens: 9000,
    output_tokens: 800,
    usd: 0.007524,
    currency: 'USD',
    nano_usd: 7_524_000,
    rate_table: 'deepseek-v4@2026-08-29',
    rate_tier: 'peak',
    ts_source: 'event',
    source: { kind: 'session-log', path: SESSION_FIXTURE, line: 3 },
  })
})

test('the tier a call fell in is read from its own timestamp', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const { lines } = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })
  const byLine = new Map(lines.map((line) => [line.source.line, line]))

  // Friday 18:30Z is outside both peak windows, so it is billed at half rate:
  // 1000 miss × 220 + 4000 hit × 7 + 250 out × 660 = 413,000 nano-USD.
  const offPeakHour = byLine.get(5)
  assert.equal(offPeakHour.rate_tier, 'off-peak')
  assert.equal(offPeakHour.nano_usd, 413_000)
  assert.equal(offPeakHour.usd, 0.000413)

  // Saturday 09:00Z is a peak *hour* on a weekend day, so it is off-peak too —
  // the day matters as much as the clock. The alias resolves to the same row:
  // 2000 miss × 660 + 100 out × 1980 = 1,518,000 nano-USD.
  const offPeakWeekend = byLine.get(11)
  assert.equal(offPeakWeekend.ts, '2026-08-29T09:00:00.000Z')
  assert.equal(offPeakWeekend.model, 'deepseek/deepseek-v4-pro')
  assert.equal(offPeakWeekend.rate_tier, 'off-peak')
  assert.equal(offPeakWeekend.nano_usd, 1_518_000)

  // The same model and counts inside a weekday peak window cost twice as much.
  const peak = byLine.get(3)
  assert.equal(peak.rate_tier, 'peak')
})

test('an event with no timestamp is stamped with the recording time and says so', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const { lines } = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })
  const line = lines.find((candidate) => candidate.source.line === 12)

  assert.equal(line.ts, RECORDED_AT)
  assert.equal(line.ts_source, 'recorded')
  assert.equal(line.rate_tier, 'peak')
  assert.equal(line.nano_usd, 35_900)
})

test('a line that cannot be priced still records its tokens, with the reason', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const { lines } = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })
  const byLine = new Map(lines.map((line) => [line.source.line, line]))

  const unknownModel = byLine.get(7)
  assert.equal(unknownModel.model, 'deepseek-v9-experimental')
  assert.equal(unknownModel.input_tokens, 100)
  assert.equal(unknownModel.output_tokens, 10)
  assert.equal(unknownModel.usd, null)
  assert.equal(unknownModel.nano_usd, null)
  assert.equal(unknownModel.unpriced_reason, UNPRICED_REASONS.MODEL_NOT_IN_RATE_TABLE)

  const unknownSplit = byLine.get(8)
  assert.equal(unknownSplit.model, 'deepseek-v4-pro')
  assert.equal(unknownSplit.input_tokens, 400)
  assert.equal(unknownSplit.cache_hit_tokens, null)
  assert.equal(unknownSplit.usd, null)
  assert.equal(unknownSplit.unpriced_reason, UNPRICED_REASONS.CACHE_SPLIT_UNKNOWN)
})

test('a usage-shaped line that could not be read is reported, not swallowed', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const { skipped } = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })

  assert.deepEqual(skipped, [
    { line: 6, reason: UNPARSEABLE_JSON },
    { line: 9, reason: SKIP_REASONS.INVALID_COUNT, field: 'input_tokens' },
  ])
})

test('usage inherits the session the log most recently declared', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const { lines } = syncFromSessionLog({
    logPath: SESSION_FIXTURE,
    receiptPath,
    recordedAt: RECORDED_AT,
  })

  assert.deepEqual(
    lines.map((line) => [line.source.line, line.session_id]),
    [
      [3, 'sess-7c2'],
      [5, 'sess-7c2'],
      [7, 'sess-7c2'],
      [8, 'sess-7c2'],
      [11, 'sess-9f1'],
      [12, 'sess-9f1'],
    ],
  )
})

test('sweeping the same log twice appends nothing the second time', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const options = { logPath: SESSION_FIXTURE, receiptPath, recordedAt: RECORDED_AT }

  const first = syncFromSessionLog(options)
  const afterFirst = readFileSync(receiptPath, 'utf8')

  const second = syncFromSessionLog(options)

  assert.equal(first.appended, 6)
  assert.equal(second.appended, 0)
  assert.equal(second.scanned, 0)
  assert.equal(second.cursor, 12)
  assert.equal(readFileSync(receiptPath, 'utf8'), afterFirst)
})

test('a log that has grown is resumed from the cursor, and the file only grows', () => {
  const dir = scratch()
  const logPath = join(dir, 'session.jsonl')
  const receiptPath = join(dir, 'receipt.jsonl')
  copyFileSync(SESSION_FIXTURE, logPath)

  syncFromSessionLog({ logPath, receiptPath, recordedAt: RECORDED_AT })
  const afterFirst = readFileSync(receiptPath, 'utf8')

  appendFileSync(logPath, readFileSync(APPENDED_FIXTURE, 'utf8'), 'utf8')
  const second = syncFromSessionLog({ logPath, receiptPath, recordedAt: RECORDED_AT })

  assert.equal(second.appended, 1)
  assert.equal(second.scanned, 1)
  assert.equal(second.cursor, 13)

  // Saturday 21:00Z, so off-peak on both counts:
  // 400 miss × 220 + 600 hit × 7 + 80 out × 660 = 145,000 nano-USD.
  const [line] = second.lines
  assert.equal(line.nano_usd, 145_000)
  assert.equal(line.rate_tier, 'off-peak')
  // The session header above the cursor is still tracked, so attribution holds.
  assert.equal(line.session_id, 'sess-9f1')

  // Append-only: yesterday's bytes are still today's opening bytes.
  const afterSecond = readFileSync(receiptPath, 'utf8')
  assert.ok(afterSecond.startsWith(afterFirst))
  assert.equal(afterSecond.slice(afterFirst.length).trimEnd(), JSON.stringify(line))
})

test('the cursor is the receipt itself, keyed by the log it cites', () => {
  const dir = scratch()
  const receiptPath = join(dir, 'receipt.jsonl')
  const otherLog = join(dir, 'other.jsonl')
  writeFileSync(otherLog, '', 'utf8')

  assert.equal(lastRecordedLine(receiptPath, SESSION_FIXTURE), 0)

  syncFromSessionLog({ logPath: SESSION_FIXTURE, receiptPath, recordedAt: RECORDED_AT })

  assert.equal(lastRecordedLine(receiptPath, SESSION_FIXTURE), 12)
  assert.equal(lastRecordedLine(receiptPath, otherLog), 0)
})

test('a missing session log is an error; a missing receipt is simply empty', () => {
  const dir = scratch()
  assert.deepEqual(readReceiptLines(join(dir, 'nothing-here.jsonl')), { lines: [], malformed: [] })
  assert.throws(
    () => syncFromSessionLog({ logPath: join(dir, 'no-log.jsonl'), receiptPath: join(dir, 'r.jsonl') }),
    /session log not found/,
  )
})

test('one corrupt receipt line is counted, not thrown, so the rest stays readable', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  appendReceiptLines(receiptPath, [{ model: 'deepseek-v4-pro', nano_usd: 1 }])
  appendFileSync(receiptPath, 'half a line\n', 'utf8')
  appendReceiptLines(receiptPath, [{ model: 'deepseek-v4-flash', nano_usd: 2 }])

  const { lines, malformed } = readReceiptLines(receiptPath)

  assert.equal(lines.length, 2)
  assert.deepEqual(malformed, [2])
})

test('recordUsage appends one line per readable event and names why it skipped the rest', () => {
  const receiptPath = join(scratch(), 'receipt.jsonl')
  const options = { receiptPath, sessionId: 'sess-direct', recordedAt: RECORDED_AT }

  const good = recordUsage(
    {
      ts: '2026-08-28T09:00:00Z',
      model: 'deepseek-v4-flash',
      usage: { input_tokens: 1000, cache_hit_tokens: 800, output_tokens: 100 },
    },
    options,
  )
  const bad = recordUsage({ model: 'deepseek-v4-flash', usage: { output_tokens: 1 } }, options)

  // Friday 09:00Z, inside the second peak window:
  // 200 miss × 440 + 800 hit × 14 + 100 out × 1320 = 231,200 nano-USD.
  assert.equal(good.skipped, null)
  assert.equal(good.recorded.nano_usd, 231_200)
  assert.equal(good.recorded.session_id, 'sess-direct')
  assert.equal(bad.recorded, null)
  assert.equal(bad.skipped, SKIP_REASONS.MISSING_INPUT_TOKENS)

  assert.equal(readReceiptLines(receiptPath).lines.length, 1)
})

test('a line with no usable instant is unpriced rather than billed at either tier', () => {
  const line = receiptLineFor({
    ts: null,
    ts_source: 'recorded',
    session_id: 'sess-x',
    model: 'deepseek-v4-pro',
    input_tokens: 100,
    cache_hit_tokens: 10,
    output_tokens: 5,
  })

  assert.equal(line.rate_tier, null)
  assert.equal(line.usd, null)
  assert.equal(line.nano_usd, null)
  assert.equal(line.unpriced_reason, UNPRICED_REASONS.TIMESTAMP_UNKNOWN)
  assert.equal(line.input_tokens, 100)
  assert.equal(line.output_tokens, 5)
})

test('appending creates the receipt and its directory, and writes one line per record', () => {
  const receiptPath = join(scratch(), 'nested', 'deeper', 'receipt.jsonl')

  assert.equal(appendReceiptLines(receiptPath, []), 0)
  assert.equal(appendReceiptLines(receiptPath, [{ a: 1 }, { b: 2 }]), 2)

  assert.equal(readFileSync(receiptPath, 'utf8'), '{"a":1}\n{"b":2}\n')
})

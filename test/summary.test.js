/**
 * Reporting over a fixed receipt fixture: the window, the totals, and the
 * cache-hit rate.
 *
 * The fixture deliberately contains the awkward lines — an unpriced model, an
 * unknown cache split, and a line written with `usd` but no `nano_usd` — so the
 * arithmetic is tested where it is actually load-bearing rather than on five
 * clean rows.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readReceiptLines } from '../src/receipt.js'
import { DEFAULT_LIMIT, cacheHitRate, summarize, totalsOf } from '../src/summary.js'

const RECEIPT_FIXTURE = fileURLToPath(new URL('./fixtures/receipt.jsonl', import.meta.url))

/** The five checked-in receipt lines, parsed. */
const { lines: FIXTURE } = readReceiptLines(RECEIPT_FIXTURE)

test('the fixture is the five lines the rest of this file reasons about', () => {
  assert.equal(FIXTURE.length, 5)
  assert.deepEqual(
    FIXTURE.map((line) => line.usd),
    [0.007524, 0.000413, null, null, 0.000014],
  )
})

test('totals sum the priced lines exactly and count the rest separately', () => {
  const totals = totalsOf(FIXTURE)

  assert.equal(totals.lines, 5)
  assert.equal(totals.priced_lines, 3)
  assert.equal(totals.unpriced_lines, 2)
  assert.equal(totals.input_tokens, 12000 + 5000 + 100 + 400 + 1000)
  assert.equal(totals.cache_hit_tokens, 9000 + 4000 + 0 + 1000)
  assert.equal(totals.output_tokens, 800 + 250 + 10 + 40 + 0)
  // 7,524,000 + 413,000 + 14,000, the last recovered from a line with no `nano_usd`.
  assert.equal(totals.nano_usd, 7_951_000)
  assert.equal(totals.usd, 0.007951)
  assert.equal(totals.currency, 'USD')
})

test('an unpriced line contributes tokens but never a silent zero to the money', () => {
  const unpriced = FIXTURE.filter((line) => line.usd === null)
  const priced = FIXTURE.filter((line) => line.usd !== null)

  assert.equal(totalsOf(unpriced).usd, 0)
  assert.equal(totalsOf(unpriced).priced_lines, 0)
  assert.equal(totalsOf(unpriced).input_tokens, 500)
  // Dropping the unpriced lines changes the counts, not the total cost.
  assert.equal(totalsOf(priced).nano_usd, totalsOf(FIXTURE).nano_usd)
})

test('the cache-hit rate is measured only over lines whose split is known', () => {
  const { rate, basis } = cacheHitRate(FIXTURE)

  assert.equal(basis.lines_with_known_split, 4)
  assert.equal(basis.lines_with_unknown_split, 1)
  // The 400-token line with an unknown split is out of both halves of the ratio.
  assert.equal(basis.input_tokens, 12000 + 5000 + 100 + 1000)
  assert.equal(basis.cache_hit_tokens, 14000)
  assert.equal(rate, Number((14000 / 18100).toFixed(6)))
  assert.ok(rate > 0.77 && rate < 0.78)
})

test('a receipt with no known split, or no prompt tokens, has no rate at all', () => {
  assert.equal(cacheHitRate([]).rate, null)
  assert.equal(cacheHitRate([{ input_tokens: 10, cache_hit_tokens: null }]).rate, null)
  assert.equal(cacheHitRate([{ input_tokens: 0, cache_hit_tokens: 0 }]).rate, null)
  assert.equal(cacheHitRate([{ input_tokens: 10, cache_hit_tokens: 10 }]).rate, 1)
  assert.equal(cacheHitRate([{ input_tokens: 10, cache_hit_tokens: 0 }]).rate, 0)
})

test('the window is the trailing N lines, and the totals come in both scopes', () => {
  const summary = summarize(FIXTURE, { limit: 2 })

  assert.equal(summary.returned, 2)
  assert.equal(summary.total_lines, 5)
  assert.deepEqual(summary.lines, FIXTURE.slice(3))

  assert.equal(summary.totals.lines, 5)
  assert.equal(summary.totals.nano_usd, 7_951_000)

  assert.equal(summary.window_totals.lines, 2)
  assert.equal(summary.window_totals.nano_usd, 14_000)
  assert.equal(summary.window_totals.unpriced_lines, 1)
  assert.equal(summary.window_cache_hit_rate.rate, 1)
})

test('a limit larger than the receipt returns the whole receipt, not a padded one', () => {
  const summary = summarize(FIXTURE, { limit: 500 })

  assert.equal(summary.returned, 5)
  assert.deepEqual(summary.lines, FIXTURE)
  assert.deepEqual(summary.window_totals, summary.totals)
  assert.deepEqual(summary.window_cache_hit_rate, summary.cache_hit_rate)
})

test('an empty receipt summarises to zeros rather than to nothing', () => {
  const summary = summarize([])

  assert.equal(summary.returned, 0)
  assert.equal(summary.total_lines, 0)
  assert.equal(summary.totals.usd, 0)
  assert.equal(summary.totals.nano_usd, 0)
  assert.equal(summary.cache_hit_rate.rate, null)
})

test('the default limit applies when none is given, and a bad one is refused', () => {
  const many = Array.from({ length: DEFAULT_LIMIT + 5 }, (_unused, index) => ({
    input_tokens: index,
    cache_hit_tokens: 0,
    output_tokens: 0,
    nano_usd: index,
  }))

  assert.equal(summarize(many).returned, DEFAULT_LIMIT)
  assert.equal(summarize(many, {}).returned, DEFAULT_LIMIT)

  for (const limit of [0, -1, 2.5, '10']) {
    assert.throws(() => summarize(many, { limit }), RangeError, String(limit))
  }
})

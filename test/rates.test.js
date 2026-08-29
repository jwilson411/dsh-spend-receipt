/**
 * The rate table is the one thing in this package that cannot be re-derived
 * from its inputs, so these tests pin it: the published numbers, the date they
 * were captured on, the peak schedule's exact boundaries, and the fact that
 * arithmetic over them stays in integers.
 *
 * Nothing here touches the filesystem or the network.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CURRENCY,
  MODEL_ALIASES,
  PEAK_SCHEDULE_UTC,
  RATE_TABLE,
  RATE_TABLE_DATE,
  RATE_TABLE_ID,
  RATE_TABLE_SOURCE,
  TIERS,
  canonicalModel,
  describeRateTable,
  nanoUsdToUsd,
  priceNanoUsd,
  rateFor,
  tierAt,
} from '../src/rates.js'

/** The published peak price list, in USD per 1M tokens, as captured on the table's date. */
const PUBLISHED_PEAK_USD_PER_1M = {
  'deepseek-v4-pro': { input_cache_hit: 0.044, input_cache_miss: 1.32, output: 3.96 },
  'deepseek-v4-flash': { input_cache_hit: 0.014, input_cache_miss: 0.44, output: 1.32 },
}

test('the table is dated and carries the source it was captured from', () => {
  assert.equal(RATE_TABLE_DATE, '2026-08-29')
  assert.equal(RATE_TABLE_ID, `deepseek-v4@${RATE_TABLE_DATE}`)
  assert.equal(CURRENCY, 'USD')
  assert.equal(RATE_TABLE_SOURCE.publisher, 'DeepSeek')
  assert.equal(RATE_TABLE_SOURCE.captured, RATE_TABLE_DATE)
  assert.match(RATE_TABLE_SOURCE.url, /^https:\/\//)
})

test('peak rates are the published USD-per-1M prices, stored as exact nano-USD', () => {
  assert.deepEqual(Object.keys(RATE_TABLE).sort(), Object.keys(PUBLISHED_PEAK_USD_PER_1M).sort())

  for (const [model, published] of Object.entries(PUBLISHED_PEAK_USD_PER_1M)) {
    for (const [field, usdPerMillion] of Object.entries(published)) {
      const nano = RATE_TABLE[model].peak[field]
      assert.ok(Number.isSafeInteger(nano), `${model}.${field} must be an integer, got ${nano}`)
      // nano-USD per token × 1e6 tokens ÷ 1e9 nano = USD per 1M tokens.
      assert.equal((nano * 1e6) / 1e9, usdPerMillion, `${model}.${field}`)
    }
  }
})

test('off-peak is exactly half of peak, for every model and every field', () => {
  for (const [model, tiers] of Object.entries(RATE_TABLE)) {
    for (const field of Object.keys(tiers.peak)) {
      assert.equal(tiers['off-peak'][field] * 2, tiers.peak[field], `${model}.${field}`)
      assert.ok(Number.isSafeInteger(tiers['off-peak'][field]))
    }
  }
})

test('the table and its rows are frozen, so nothing can retro-price an old line', () => {
  assert.ok(Object.isFrozen(RATE_TABLE))
  for (const tiers of Object.values(RATE_TABLE)) {
    assert.ok(Object.isFrozen(tiers))
    assert.ok(Object.isFrozen(tiers.peak))
    assert.ok(Object.isFrozen(tiers['off-peak']))
  }
})

test('the peak schedule is two weekday windows, 01:00–04:00 and 06:00–10:00 UTC', () => {
  assert.deepEqual([...PEAK_SCHEDULE_UTC.days], [1, 2, 3, 4, 5])
  assert.deepEqual(
    PEAK_SCHEDULE_UTC.windows.map((window) => [window.start_minute, window.end_minute]),
    [
      [60, 240],
      [360, 600],
    ],
  )
  assert.equal(PEAK_SCHEDULE_UTC.label, '01:00–04:00 and 06:00–10:00 UTC, Mon–Fri')
})

test('on a weekday, peak is the two windows and everything around them is not', () => {
  // 2026-08-28 is a Friday.
  const cases = [
    ['2026-08-28T00:00:00Z', TIERS.OFF_PEAK],
    ['2026-08-28T00:59:59Z', TIERS.OFF_PEAK],
    ['2026-08-28T01:00:00Z', TIERS.PEAK],
    ['2026-08-28T03:59:59Z', TIERS.PEAK],
    // The gap between the windows is off-peak, not a continuation of them.
    ['2026-08-28T04:00:00Z', TIERS.OFF_PEAK],
    ['2026-08-28T05:30:00Z', TIERS.OFF_PEAK],
    ['2026-08-28T06:00:00Z', TIERS.PEAK],
    ['2026-08-28T09:59:59Z', TIERS.PEAK],
    ['2026-08-28T10:00:00Z', TIERS.OFF_PEAK],
    ['2026-08-28T18:30:00Z', TIERS.OFF_PEAK],
    ['2026-08-28T23:59:59Z', TIERS.OFF_PEAK],
  ]
  for (const [ts, expected] of cases) assert.equal(tierAt(ts), expected, ts)
})

test('every weekday carries the schedule, and the weekend carries none of it', () => {
  // Monday through Friday, each inside a peak window.
  for (const day of ['2026-08-31', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28']) {
    assert.equal(tierAt(`${day}T02:00:00Z`), TIERS.PEAK, day)
    assert.equal(tierAt(`${day}T07:00:00Z`), TIERS.PEAK, day)
  }

  // The same hours on Saturday and Sunday are off-peak: the discount is not
  // only about the hour, it is about the day.
  for (const day of ['2026-08-29', '2026-08-30']) {
    assert.equal(tierAt(`${day}T02:00:00Z`), TIERS.OFF_PEAK, day)
    assert.equal(tierAt(`${day}T07:00:00Z`), TIERS.OFF_PEAK, day)
  }
})

test('the tier is read in UTC, not in whatever zone the offset is written in', () => {
  // 04:00+02:00 is 02:00 UTC on the Friday — inside the first peak window,
  // even though its local clock reads like the off-peak gap.
  assert.equal(tierAt('2026-08-28T04:00:00+02:00'), TIERS.PEAK)

  // 03:00+02:00 is 01:00 UTC on the Saturday: a peak *hour* on a weekend day.
  assert.equal(tierAt('2026-08-29T03:00:00+02:00'), TIERS.OFF_PEAK)

  // The offset can move the instant across a day boundary too: this reads as
  // Monday 02:00 locally but is Sunday 23:00 UTC, so it is off-peak.
  assert.equal(tierAt('2026-08-31T02:00:00+03:00'), TIERS.OFF_PEAK)
})

test('an unusable instant yields no tier rather than defaulting to peak', () => {
  for (const value of [null, undefined, '', '   ', 'yesterday', 42, {}]) {
    assert.equal(tierAt(value), null, JSON.stringify(value) ?? String(value))
  }
})

test('aliases resolve to the same row; near neighbours do not resolve at all', () => {
  for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
    assert.equal(canonicalModel(alias), canonical)
  }
  assert.equal(canonicalModel('  deepseek-v4-pro  '), 'deepseek-v4-pro')

  for (const unknown of ['deepseek-v4', 'deepseek-v4-pro-preview', 'deepseek-v3.2', '', null, 7]) {
    assert.equal(canonicalModel(unknown), null, String(unknown))
  }
})

test('pricing multiplies reported counts by the tier the call fell in', () => {
  const tokens = { input_tokens: 12000, cache_hit_tokens: 9000, output_tokens: 800 }

  // 3000 miss × 1320 + 9000 hit × 44 + 800 out × 3960
  assert.equal(priceNanoUsd('deepseek-v4-pro', tokens, TIERS.PEAK), 7_524_000)
  assert.equal(priceNanoUsd('deepseek-v4-pro', tokens, TIERS.OFF_PEAK), 3_762_000)
  assert.equal(
    priceNanoUsd('deepseek-v4-pro', tokens, TIERS.OFF_PEAK) * 2,
    priceNanoUsd('deepseek-v4-pro', tokens, TIERS.PEAK),
  )
})

test('costs stay integers, so a long receipt adds up without drift', () => {
  const tokens = { input_tokens: 3, cache_hit_tokens: 1, output_tokens: 1 }
  const once = priceNanoUsd('deepseek-v4-flash', tokens, TIERS.PEAK)
  assert.ok(Number.isSafeInteger(once))

  let summed = 0
  for (let index = 0; index < 10_000; index += 1) summed += once
  assert.equal(summed, once * 10_000)
  // The same sum in USD floats does not land on the exact value.
  assert.equal(nanoUsdToUsd(summed), Number((summed / 1e9).toFixed(9)))
})

test('an unknown model or an unknown tier is not priced', () => {
  const tokens = { input_tokens: 10, cache_hit_tokens: 0, output_tokens: 1 }
  assert.equal(priceNanoUsd('deepseek-v9-experimental', tokens, TIERS.PEAK), null)
  assert.equal(priceNanoUsd('deepseek-v4-pro', tokens, null), null)
  assert.equal(rateFor('deepseek-v4-pro', 'twilight'), null)
  assert.equal(rateFor('nope', TIERS.PEAK), null)
})

test('impossible or unusable counts throw instead of being coerced', () => {
  const tier = TIERS.PEAK
  assert.throws(
    () => priceNanoUsd('deepseek-v4-pro', { input_tokens: 10, cache_hit_tokens: 11, output_tokens: 0 }, tier),
    RangeError,
  )
  for (const bad of [
    { input_tokens: -1, cache_hit_tokens: 0, output_tokens: 0 },
    { input_tokens: 1.5, cache_hit_tokens: 0, output_tokens: 0 },
    { input_tokens: 10, cache_hit_tokens: null, output_tokens: 0 },
    { input_tokens: 10, cache_hit_tokens: 0 },
  ]) {
    assert.throws(() => priceNanoUsd('deepseek-v4-pro', bad, tier), RangeError, JSON.stringify(bad))
  }
})

test('nano-USD converts to USD, and null stays null', () => {
  assert.equal(nanoUsdToUsd(7_524_000), 0.007524)
  assert.equal(nanoUsdToUsd(1), 1e-9)
  assert.equal(nanoUsdToUsd(0), 0)
  assert.equal(nanoUsdToUsd(null), null)
})

test('the table describes itself for the tool and the CLI', () => {
  const described = describeRateTable()

  assert.equal(described.id, RATE_TABLE_ID)
  assert.equal(described.date, RATE_TABLE_DATE)
  assert.equal(described.currency, CURRENCY)
  assert.equal(described.peak_schedule_utc, PEAK_SCHEDULE_UTC.label)
  assert.deepEqual(described.source, { ...RATE_TABLE_SOURCE })

  assert.deepEqual(described.models['deepseek-v4-pro'].peak, {
    input_cache_hit_usd_per_1m: 0.044,
    input_cache_miss_usd_per_1m: 1.32,
    output_usd_per_1m: 3.96,
  })
  assert.deepEqual(described.models['deepseek-v4-flash']['off-peak'], {
    input_cache_hit_usd_per_1m: 0.007,
    input_cache_miss_usd_per_1m: 0.22,
    output_usd_per_1m: 0.66,
  })

  // Describing must not hand out the frozen table's own objects to mutate.
  described.models['deepseek-v4-pro'].peak.output_usd_per_1m = 99
  assert.equal(describeRateTable().models['deepseek-v4-pro'].peak.output_usd_per_1m, 3.96)
})

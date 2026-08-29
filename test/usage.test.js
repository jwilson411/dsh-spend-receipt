/**
 * The "no invented tokens" rule, tested as a rule rather than as a happy path.
 *
 * Most of these cases are events that a laxer reader would happily turn into a
 * number: a prompt total with no cache split, a completion count with no prompt
 * count, a timestamp that is not there. Each one must produce a *reason*, or a
 * null, and never a substituted zero.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SKIP_REASONS, normalizeUsageEvent } from '../src/usage.js'

/** Recording facts supplied by the caller, never by the event. */
const DEFAULTS = { sessionId: 'sess-fallback', recordedAt: '2026-08-29T12:00:00.000Z' }

test('the canonical DeepSeek shape reads straight through', () => {
  const result = normalizeUsageEvent(
    {
      type: 'llm_usage',
      ts: '2026-08-29T09:00:12Z',
      session_id: 'sess-7c2',
      model: 'deepseek-v4-pro',
      usage: {
        prompt_tokens: 12000,
        prompt_cache_hit_tokens: 9000,
        prompt_cache_miss_tokens: 3000,
        completion_tokens: 800,
      },
    },
    DEFAULTS,
  )

  assert.ok(result.ok)
  assert.deepEqual(result.usage, {
    ts: '2026-08-29T09:00:12.000Z',
    ts_source: 'event',
    session_id: 'sess-7c2',
    model: 'deepseek-v4-pro',
    input_tokens: 12000,
    cache_hit_tokens: 9000,
    output_tokens: 800,
  })
})

test('alternative spellings of the same counts are accepted', () => {
  const shapes = [
    { input_tokens: 100, cache_hit_tokens: 40, output_tokens: 10 },
    { inputTokens: 100, cacheHitTokens: 40, outputTokens: 10 },
    { promptTokens: 100, promptCacheHitTokens: 40, completionTokens: 10 },
    { prompt_tokens: 100, cache_read_input_tokens: 40, completion_tokens: 10 },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 10 },
  ]

  for (const usage of shapes) {
    const result = normalizeUsageEvent({ model: 'deepseek-v4-pro', usage }, DEFAULTS)
    assert.ok(result.ok, JSON.stringify(usage))
    assert.equal(result.usage.input_tokens, 100)
    assert.equal(result.usage.cache_hit_tokens, 40)
    assert.equal(result.usage.output_tokens, 10)
  }
})

test('counts are found wherever the event nests them, including at the top level', () => {
  const nestings = [
    { model: 'deepseek-v4-pro', usage: { input_tokens: 5, cache_hit_tokens: 1, output_tokens: 2 } },
    {
      model: 'deepseek-v4-pro',
      response: { usage: { input_tokens: 5, cache_hit_tokens: 1, output_tokens: 2 } },
    },
    { model: 'deepseek-v4-pro', input_tokens: 5, cache_hit_tokens: 1, output_tokens: 2 },
  ]

  for (const event of nestings) {
    const result = normalizeUsageEvent(event, DEFAULTS)
    assert.ok(result.ok, JSON.stringify(event))
    assert.equal(result.usage.input_tokens, 5)
  }
})

test('hit plus miss is the reported total restated, and is the only derivation allowed', () => {
  const result = normalizeUsageEvent(
    {
      model: 'deepseek-v4-flash',
      usage: {
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 100,
        completion_tokens: 5,
      },
    },
    DEFAULTS,
  )

  assert.ok(result.ok)
  assert.equal(result.usage.input_tokens, 1000)
  assert.equal(result.usage.cache_hit_tokens, 900)
})

test('an unreported cache split stays unknown rather than becoming zero', () => {
  const result = normalizeUsageEvent(
    { model: 'deepseek-v4-pro', usage: { prompt_tokens: 400, completion_tokens: 40 } },
    DEFAULTS,
  )

  assert.ok(result.ok)
  assert.equal(result.usage.input_tokens, 400)
  assert.equal(result.usage.cache_hit_tokens, null)
})

test('a missing prompt or completion count is a skip, not a zero', () => {
  const noInput = normalizeUsageEvent(
    { model: 'deepseek-v4-pro', usage: { completion_tokens: 50 } },
    DEFAULTS,
  )
  assert.equal(noInput.ok, false)
  assert.equal(noInput.reason, SKIP_REASONS.MISSING_INPUT_TOKENS)

  const noOutput = normalizeUsageEvent(
    { model: 'deepseek-v4-pro', usage: { prompt_tokens: 50 } },
    DEFAULTS,
  )
  assert.equal(noOutput.ok, false)
  assert.equal(noOutput.reason, SKIP_REASONS.MISSING_OUTPUT_TOKENS)
})

test('a count that is present but not a count is rejected, naming the field', () => {
  for (const [usage, field] of [
    [{ prompt_tokens: -5, completion_tokens: 1 }, 'input_tokens'],
    [{ prompt_tokens: 1.5, completion_tokens: 1 }, 'input_tokens'],
    [{ prompt_tokens: '100', completion_tokens: 1 }, 'input_tokens'],
    [{ prompt_tokens: 10, prompt_cache_hit_tokens: -1, completion_tokens: 1 }, 'cache_hit_tokens'],
    [{ prompt_tokens: 10, completion_tokens: Number.NaN }, 'output_tokens'],
  ]) {
    const result = normalizeUsageEvent({ model: 'deepseek-v4-pro', usage }, DEFAULTS)
    assert.equal(result.ok, false, JSON.stringify(usage))
    assert.equal(result.reason, SKIP_REASONS.INVALID_COUNT)
    assert.equal(result.field, field)
  }
})

test('more cache hits than prompt tokens is impossible and is refused', () => {
  const result = normalizeUsageEvent(
    {
      model: 'deepseek-v4-pro',
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 11, completion_tokens: 1 },
    },
    DEFAULTS,
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, SKIP_REASONS.CACHE_HIT_EXCEEDS_INPUT)
})

test('an event with no model cannot be priced and is not read', () => {
  const result = normalizeUsageEvent(
    { usage: { prompt_tokens: 10, completion_tokens: 1 } },
    DEFAULTS,
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, SKIP_REASONS.MISSING_MODEL)
})

test('events that were never about usage are passed over quietly', () => {
  const notUsage = [
    { type: 'message', role: 'user', text: 'hello' },
    { type: 'session_start', session_id: 'sess-7c2' },
    { type: 'tool_call', name: 'read_file', model: 'deepseek-v4-pro' },
  ]
  for (const event of notUsage) {
    const result = normalizeUsageEvent(event, DEFAULTS)
    assert.equal(result.ok, false, JSON.stringify(event))
    assert.equal(result.reason, SKIP_REASONS.NO_USAGE_PAYLOAD)
  }

  for (const value of [null, undefined, 'a string', 42, ['array']]) {
    const result = normalizeUsageEvent(value, DEFAULTS)
    assert.equal(result.ok, false)
    assert.equal(result.reason, SKIP_REASONS.NOT_AN_OBJECT)
  }
})

test('a timestamp the event did not carry is labelled as the recording time', () => {
  const result = normalizeUsageEvent(
    { model: 'deepseek-v4-pro', usage: { input_tokens: 1, cache_hit_tokens: 0, output_tokens: 1 } },
    DEFAULTS,
  )

  assert.ok(result.ok)
  assert.equal(result.usage.ts, DEFAULTS.recordedAt)
  assert.equal(result.usage.ts_source, 'recorded')
})

test('timestamps are normalised to ISO instants; epoch numbers are milliseconds', () => {
  const at = (ts) =>
    normalizeUsageEvent(
      { ts, model: 'deepseek-v4-pro', usage: { input_tokens: 1, cache_hit_tokens: 0, output_tokens: 1 } },
      DEFAULTS,
    ).usage

  assert.equal(at('2026-08-29T09:00:12Z').ts, '2026-08-29T09:00:12.000Z')
  assert.equal(at('2026-08-29T11:00:12+02:00').ts, '2026-08-29T09:00:12.000Z')
  assert.equal(at(1_787_000_000_000).ts, new Date(1_787_000_000_000).toISOString())
  assert.equal(at(1_787_000_000_000).ts_source, 'event')

  // Unparseable is the same as absent: the recording time, honestly labelled.
  assert.equal(at('not a date').ts, DEFAULTS.recordedAt)
  assert.equal(at('not a date').ts_source, 'recorded')
})

test('the session comes from the event first, then the caller, then nothing', () => {
  const usage = { input_tokens: 1, cache_hit_tokens: 0, output_tokens: 1 }

  const own = normalizeUsageEvent({ session_id: 'sess-own', model: 'm', usage }, DEFAULTS)
  assert.equal(own.usage.session_id, 'sess-own')

  const camel = normalizeUsageEvent({ sessionId: 'sess-camel', model: 'm', usage }, DEFAULTS)
  assert.equal(camel.usage.session_id, 'sess-camel')

  const fallback = normalizeUsageEvent({ model: 'm', usage }, DEFAULTS)
  assert.equal(fallback.usage.session_id, DEFAULTS.sessionId)

  const none = normalizeUsageEvent({ model: 'm', usage }, {})
  assert.equal(none.usage.session_id, null)
})

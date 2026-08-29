/**
 * Reading usage events without inventing anything.
 *
 * This module is the whole "no invented tokens" rule in one place. It reads
 * counts that a provider actually reported and normalises their spelling; it
 * never tokenises text, never estimates, and never substitutes a default for a
 * count the event did not carry. An event that cannot be read yields a
 * *reason*, not a guess, and the caller decides whether to skip it or record it
 * unpriced.
 *
 * One derivation is allowed, because it is arithmetic on reported counts rather
 * than a new measurement: when an event reports the cache hit and miss halves
 * of the prompt but no total, the total is their sum.
 * @module dsh-spend-receipt/usage
 */

/**
 * Why an event produced no usage record. Reported by the CLI and the tool so a
 * gap in a receipt is explainable rather than silent.
 */
export const SKIP_REASONS = Object.freeze({
  NOT_AN_OBJECT: 'not-an-object',
  NO_USAGE_PAYLOAD: 'no-usage-payload',
  MISSING_MODEL: 'missing-model',
  MISSING_INPUT_TOKENS: 'missing-input-tokens',
  MISSING_OUTPUT_TOKENS: 'missing-output-tokens',
  INVALID_COUNT: 'invalid-count',
  CACHE_HIT_EXCEEDS_INPUT: 'cache-hit-exceeds-input',
})

/** Field spellings accepted for the total billed prompt tokens. */
const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']

/** Field spellings accepted for the cache-served share of the prompt. */
const CACHE_HIT_KEYS = [
  'cache_hit_tokens',
  'cacheHitTokens',
  'prompt_cache_hit_tokens',
  'promptCacheHitTokens',
  'cache_read_input_tokens',
  'cached_tokens',
]

/** Field spellings accepted for the non-cached share of the prompt. */
const CACHE_MISS_KEYS = [
  'cache_miss_tokens',
  'cacheMissTokens',
  'prompt_cache_miss_tokens',
  'promptCacheMissTokens',
]

/** Field spellings accepted for generated tokens. */
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']

/** Field spellings accepted for the event's own timestamp. */
const TS_KEYS = ['ts', 'timestamp', 'time', 'created_at', 'createdAt']

/** Field spellings accepted for the session the event belongs to. */
const SESSION_KEYS = ['session_id', 'sessionId', 'session']

/**
 * Normalise one event into the counts a receipt line is built from.
 *
 * @param event - A parsed event object, from a usage stream or a session log line.
 * @param defaults - Fallbacks that are facts about the *recording*, not the event:
 *   `sessionId` for events that carry none, and `recordedAt` (an ISO string) used
 *   as the line's `ts` when the event has no timestamp of its own.
 * @returns `{ ok: true, usage }` with normalised counts, or `{ ok: false, reason }`
 *   naming one of {@link SKIP_REASONS}. `usage.cache_hit_tokens` is `null` when the
 *   event reported a prompt total but not how much of it the cache served — the
 *   count is unknown, so it stays unknown and the line prices as `usd: null`.
 */
export function normalizeUsageEvent(event, defaults = {}) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, reason: SKIP_REASONS.NOT_AN_OBJECT }
  }

  const payload = usagePayload(event)
  if (payload === null) return { ok: false, reason: SKIP_REASONS.NO_USAGE_PAYLOAD }

  const model = firstString(event.model, payload.model, event.request?.model)
  if (model === null) return { ok: false, reason: SKIP_REASONS.MISSING_MODEL }

  const hit = pickCount(payload, CACHE_HIT_KEYS)
  const miss = pickCount(payload, CACHE_MISS_KEYS)
  let input = pickCount(payload, INPUT_KEYS)
  const output = pickCount(payload, OUTPUT_KEYS)

  for (const [count, key] of [
    [hit, 'cache_hit_tokens'],
    [miss, 'cache_miss_tokens'],
    [input, 'input_tokens'],
    [output, 'output_tokens'],
  ]) {
    if (count === 'invalid') return { ok: false, reason: SKIP_REASONS.INVALID_COUNT, field: key }
  }

  // The one permitted derivation: hit + miss is the reported prompt total
  // restated, not a new number.
  if (input === null && hit !== null && miss !== null) input = hit + miss

  if (input === null) return { ok: false, reason: SKIP_REASONS.MISSING_INPUT_TOKENS }
  if (output === null) return { ok: false, reason: SKIP_REASONS.MISSING_OUTPUT_TOKENS }
  if (hit !== null && hit > input) {
    return { ok: false, reason: SKIP_REASONS.CACHE_HIT_EXCEEDS_INPUT }
  }

  const eventTs = normalizeTimestamp(firstDefined(event, TS_KEYS) ?? firstDefined(payload, TS_KEYS))
  const sessionId =
    firstString(...SESSION_KEYS.map((key) => event[key])) ??
    firstString(defaults.sessionId) ??
    null

  return {
    ok: true,
    usage: {
      ts: eventTs ?? defaults.recordedAt ?? null,
      ts_source: eventTs === null ? 'recorded' : 'event',
      session_id: sessionId,
      model,
      input_tokens: input,
      cache_hit_tokens: hit,
      output_tokens: output,
    },
  }
}

/**
 * Locate the object carrying the token counts.
 *
 * Events nest usage under `usage`, `usage.details`, or `response.usage`, and
 * some put the counts at the top level. OpenAI-compatible payloads hide the
 * cached share one level further down, in `prompt_tokens_details`, so that is
 * flattened in rather than searched for separately.
 * @param event - The parsed event.
 * @returns A flat object of candidate count fields, or `null` if none carries a count.
 */
function usagePayload(event) {
  const candidates = [event.usage, event.usage?.details, event.response?.usage, event]
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const details = candidate.prompt_tokens_details ?? candidate.promptTokensDetails
    const flat =
      details !== null && typeof details === 'object' && !Array.isArray(details)
        ? { ...details, ...candidate }
        : candidate
    const keys = [...INPUT_KEYS, ...OUTPUT_KEYS, ...CACHE_HIT_KEYS, ...CACHE_MISS_KEYS]
    if (keys.some((key) => Object.hasOwn(flat, key))) return flat
  }
  return null
}

/**
 * Read the first present spelling of a count.
 * @param payload - The flattened usage payload.
 * @param keys - Accepted spellings, in precedence order.
 * @returns The count, `null` if no spelling is present, or the string `'invalid'`
 *   if one is present but is not a non-negative integer.
 */
function pickCount(payload, keys) {
  for (const key of keys) {
    if (!Object.hasOwn(payload, key)) continue
    const value = payload[key]
    if (value === null || value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) return 'invalid'
    return value
  }
  return null
}

/**
 * @param source - Object to read from.
 * @param keys - Accepted spellings, in precedence order.
 * @returns The first defined value, or `undefined`.
 */
function firstDefined(source, keys) {
  for (const key of keys) {
    if (source[key] !== null && source[key] !== undefined) return source[key]
  }
  return undefined
}

/**
 * @param values - Candidates.
 * @returns The first non-empty string, or `null`.
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Normalise a timestamp to an ISO-8601 instant.
 *
 * A number is read as epoch **milliseconds**; seconds-vs-milliseconds cannot be
 * told apart from the value alone, so only one reading is supported and it is
 * the one the platform's own `Date` uses.
 * @param value - The raw timestamp.
 * @returns An ISO string, or `null` if absent or unparseable.
 */
function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

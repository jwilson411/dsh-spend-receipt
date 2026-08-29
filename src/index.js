/**
 * dsh-spend-receipt — a DeepSeek Harness function plugin that turns reported
 * usage into a citable, append-only cost receipt.
 *
 * The plugin registers exactly one model-facing tool, `spend_receipt`, against
 * the `tools` service and owns nothing else. Registration happens inside
 * `apply` so the Cordis fiber owns the effect: stopping, updating, or reloading
 * the plugin unregisters the tool with no bookkeeping here. Named exports
 * preserve the loader's injection metadata.
 *
 * Receipt lines come from one of two places, and never from a guess:
 *
 * - **Usage events**, handed to {@link recordUsage} by a host that already has
 *   a usage hook — or piped through the CLI's `record` command.
 * - **An append-only session log**, swept by {@link syncFromSessionLog}, which
 *   resumes from the highest log line the receipt already cites.
 *
 * @module dsh-spend-receipt
 */
import { resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  CURRENCY,
  PEAK_SCHEDULE_UTC,
  RATE_TABLE_DATE,
  RATE_TABLE_ID,
  RATE_TABLE_SOURCE,
  describeRateTable,
} from './rates.js'
import { readReceiptLines, recordUsage, syncFromSessionLog } from './receipt.js'
import { DEFAULT_LIMIT, summarize } from './summary.js'

export { recordUsage, syncFromSessionLog, readReceiptLines, describeRateTable, summarize }
export { RATE_TABLE_ID, RATE_TABLE_DATE, RATE_TABLE_SOURCE, PEAK_SCHEDULE_UTC, CURRENCY }

/** The plugin's own identity, echoed by the tool so a caller can confirm the source. */
export const PLUGIN_NAME = 'dsh-spend-receipt'

/** The one model-facing tool name this plugin owns. */
export const SPEND_RECEIPT_TOOL_NAME = 'spend_receipt'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'spend-receipt'

/**
 * `tools` is a hard dependency: with no registry there is nothing for this
 * plugin to do, so it waits rather than degrading.
 */
export const inject = ['tools']

/** Receipt file used when neither config nor environment names one. */
export const DEFAULT_RECEIPT_FILENAME = 'spend-receipt.jsonl'

/**
 * Resolve the plugin's effective settings.
 *
 * Precedence is patch config, then environment, then default — the patch row is
 * the deployment's stated intent, so it wins over an ambient variable.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @param env - Environment to read, injectable for tests.
 * @returns `{ receiptPath, sessionLog, sessionId, limit }` with `receiptPath` absolute.
 */
export function resolveConfig(config = {}, env = process.env) {
  const receiptPath = resolve(
    config.receiptPath ?? env.DSH_SPEND_RECEIPT_PATH ?? DEFAULT_RECEIPT_FILENAME,
  )
  const rawLog = config.sessionLog ?? env.DSH_SPEND_RECEIPT_SESSION_LOG ?? null
  return {
    receiptPath,
    sessionLog: rawLog === null ? null : resolve(rawLog),
    sessionId: config.sessionId ?? env.DSH_SPEND_RECEIPT_SESSION_ID ?? null,
    limit: config.limit ?? DEFAULT_LIMIT,
  }
}

/** A nullable value schema branch pair, since the subset expresses null as a union. */
const nullable = (spec, description) => ({
  oneOf: [spec, { type: 'null' }],
  description,
})

/** Schema for one receipt line as the tool reports it. */
const RECEIPT_LINE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ts: nullable({ type: 'string' }, 'When the call happened, ISO-8601.'),
    ts_source: {
      type: 'string',
      enum: ['event', 'recorded'],
      description:
        '`event` if the timestamp came from the usage event itself, `recorded` if the ' +
        'event carried none and this is when the line was written.',
    },
    session_id: nullable({ type: 'string' }, 'The session the call belongs to, if it was reported.'),
    model: { type: 'string', required: true, description: 'The model as the event named it.' },
    input_tokens: {
      type: 'integer',
      required: true,
      description: 'Total billed prompt tokens, cache hits included.',
    },
    cache_hit_tokens: nullable(
      { type: 'integer' },
      'Prompt tokens served from cache, or null if the provider did not report the split.',
    ),
    output_tokens: { type: 'integer', required: true, description: 'Generated tokens.' },
    usd: nullable(
      { type: 'number' },
      'Cost in USD, or null when the line could not be priced — see `unpriced_reason`.',
    ),
    nano_usd: nullable(
      { type: 'integer' },
      'The exact cost in nano-USD (1e-9 USD) that `usd` rounds; totals are summed from this.',
    ),
    currency: { type: 'string', required: true, description: 'Currency of `usd`; always USD.' },
    rate_table: {
      type: 'string',
      required: true,
      description: 'Id of the dated rate table this line was priced under.',
    },
    rate_tier: nullable(
      { type: 'string', enum: ['peak', 'off-peak'] },
      'Which tier the peak schedule put the call in, or null if its instant was unusable.',
    ),
    unpriced_reason: {
      type: 'string',
      description: 'Present only when `usd` is null: why no price could be stated.',
    },
    source: { type: 'json', description: 'Where the line was derived from.' },
  },
}

/** Schema for a block of summed lines. */
const TOTALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lines: { type: 'integer', required: true, description: 'Lines summed.' },
    priced_lines: { type: 'integer', required: true, description: 'Lines that carried a cost.' },
    unpriced_lines: {
      type: 'integer',
      required: true,
      description: 'Lines with tokens but no cost, excluded from `usd`.',
    },
    input_tokens: { type: 'integer', required: true, description: 'Total billed prompt tokens.' },
    cache_hit_tokens: {
      type: 'integer',
      required: true,
      description: 'Total prompt tokens served from cache.',
    },
    output_tokens: { type: 'integer', required: true, description: 'Total generated tokens.' },
    usd: { type: 'number', required: true, description: 'Cost of the priced lines, in USD.' },
    nano_usd: { type: 'integer', required: true, description: 'The same total, exactly.' },
    currency: { type: 'string', required: true, description: 'Currency of `usd`; always USD.' },
  },
}

/** Schema for the cache-hit rate and the slice of the receipt it was computed over. */
const CACHE_HIT_RATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rate: nullable(
      { type: 'number' },
      'cache_hit_tokens / input_tokens over lines with a known split; null if there are none.',
    ),
    basis: {
      type: 'object',
      required: true,
      additionalProperties: false,
      description: 'How much of the receipt the rate was actually computed over.',
      properties: {
        lines_with_known_split: { type: 'integer', required: true },
        lines_with_unknown_split: { type: 'integer', required: true },
        input_tokens: { type: 'integer', required: true },
        cache_hit_tokens: { type: 'integer', required: true },
      },
    },
  },
}

/**
 * Build the `spend_receipt` tool definition.
 *
 * Kept as a factory rather than a module-scope constant so nothing is
 * constructed at import time and each `apply` owns its own definition, bound to
 * its own resolved config.
 * @param settings - Resolved settings from {@link resolveConfig}.
 * @returns A registry-ready tool definition.
 */
export function createSpendReceiptTool(settings) {
  return defineTool({
    name: SPEND_RECEIPT_TOOL_NAME,
    description:
      'Report what this session has spent, from the append-only JSONL cost receipt: the last ' +
      'N receipt lines, token and USD totals, and the cache-hit rate. Reach for it when asked ' +
      'what a run cost, whether caching is working, or how much a model has been used. Costs ' +
      'come from a pinned, dated rate table — which prices peak and off-peak hours differently ' +
      '— and from reported token counts only. A call whose model, cache split, or instant is ' +
      'not known well enough to price is listed with its tokens and a null cost, never an ' +
      'estimate, so the totals understate rather than invent.',
    parameters: {
      limit: {
        type: 'integer',
        description: `How many of the most recent receipt lines to return. Default ${DEFAULT_LIMIT}.`,
      },
      sync: {
        type: 'boolean',
        description:
          'Whether to first derive any new lines from the configured session log. Default ' +
          'true; pass false to report only what has already been recorded.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          receipt_path: {
            type: 'string',
            required: true,
            description: 'The receipt file these numbers were read from.',
          },
          rate_table: {
            type: 'object',
            required: true,
            additionalProperties: false,
            description: 'The pinned rate table the receipt was priced under.',
            properties: {
              id: { type: 'string', required: true },
              date: { type: 'string', required: true, description: 'As-of date, ISO-8601.' },
              currency: { type: 'string', required: true },
              peak_schedule_utc: {
                type: 'string',
                required: true,
                description:
                  'The windows billed at the standard peak rate; every other hour, ' +
                  'including all weekend, is off-peak at half that rate.',
              },
            },
          },
          lines: {
            type: 'array',
            required: true,
            items: RECEIPT_LINE_SCHEMA,
            description: 'The last N receipt lines, oldest first.',
          },
          returned: { type: 'integer', required: true, description: 'How many lines were returned.' },
          total_lines: {
            type: 'integer',
            required: true,
            description: 'How many lines the whole receipt holds.',
          },
          totals: { ...TOTALS_SCHEMA, required: true, description: 'Totals over the whole receipt.' },
          cache_hit_rate: {
            ...CACHE_HIT_RATE_SCHEMA,
            required: true,
            description: 'Cache-hit rate over the whole receipt.',
          },
          window_totals: {
            ...TOTALS_SCHEMA,
            required: true,
            description: 'Totals over the returned lines only.',
          },
          window_cache_hit_rate: {
            ...CACHE_HIT_RATE_SCHEMA,
            required: true,
            description: 'Cache-hit rate over the returned lines only.',
          },
          malformed_lines: {
            type: 'array',
            required: true,
            items: { type: 'integer' },
            description: 'Line numbers in the receipt that did not parse, if any.',
          },
          synced: nullable(
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                appended: { type: 'integer', required: true },
                skipped: {
                  type: 'array',
                  required: true,
                  items: { type: 'json' },
                  description: 'Log lines that looked like usage but produced nothing, with reasons.',
                },
                scanned: { type: 'integer', required: true },
                error: { type: 'string', description: 'Why the sync could not run, if it could not.' },
              },
            },
            'What the session-log sweep did, or null if no log is configured or sync was skipped.',
          ),
          plugin: {
            type: 'string',
            required: true,
            const: PLUGIN_NAME,
            description: 'The plugin that registered the tool that answered.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    execute(args) {
      const limit = args.limit ?? settings.limit
      const synced =
        args.sync === false || settings.sessionLog === null
          ? null
          : sweep(settings, new Date().toISOString())

      const { lines, malformed } = readReceiptLines(settings.receiptPath)
      const summary = summarize(lines, { limit })

      return Promise.resolve({
        receipt_path: settings.receiptPath,
        rate_table: {
          id: RATE_TABLE_ID,
          date: RATE_TABLE_DATE,
          currency: CURRENCY,
          peak_schedule_utc: PEAK_SCHEDULE_UTC.label,
        },
        ...summary,
        malformed_lines: malformed,
        synced,
        plugin: PLUGIN_NAME,
      })
    },
  })
}

/**
 * Sweep the configured session log, reporting failure rather than throwing.
 *
 * A mistyped or not-yet-created log path should not make the whole receipt
 * unreadable, so the sweep's failure is data the caller can see and act on.
 * @param settings - Resolved settings.
 * @param recordedAt - ISO instant used for events that carry no timestamp.
 * @returns The sweep result, with `error` set if it could not run.
 */
function sweep(settings, recordedAt) {
  try {
    const result = syncFromSessionLog({
      logPath: settings.sessionLog,
      receiptPath: settings.receiptPath,
      sessionId: settings.sessionId,
      recordedAt,
    })
    return { appended: result.appended, skipped: result.skipped, scanned: result.scanned }
  } catch (error) {
    return { appended: 0, skipped: [], scanned: 0, error: error.message }
  }
}

/**
 * Project a validated tool result into the one line of prose the model reads.
 * @param value - The tool's canonical result.
 * @returns A compact summary.
 */
function renderSummary(value) {
  const { totals, cache_hit_rate: hitRate } = value
  const rate = hitRate.rate === null ? 'n/a' : `${(hitRate.rate * 100).toFixed(1)}%`
  const unpriced =
    totals.unpriced_lines === 0 ? '' : `, ${totals.unpriced_lines} line(s) unpriced`
  return (
    `${value.returned} of ${value.total_lines} receipt line(s) from ${value.receipt_path}. ` +
    `Total ${totals.usd.toFixed(6)} ${totals.currency} over ${totals.input_tokens} input ` +
    `(${totals.cache_hit_tokens} cached) and ${totals.output_tokens} output tokens; ` +
    `cache-hit rate ${rate}${unpriced}. Priced under rate table ${value.rate_table.id}.`
  )
}

/**
 * Register the plugin's single tool for the lifetime of this plugin's fiber.
 * @param ctx - the injected Cordis context, with `tools` resolved.
 * @param config - the `config` block of this plugin's row in the composed patch.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register(createSpendReceiptTool(resolveConfig(config)))
}

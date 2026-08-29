#!/usr/bin/env node
/**
 * `dsh-spend-receipt` — the same receipt the `spend_receipt` tool reads, from a
 * shell.
 *
 * The CLI is deliberately the thinner half: it parses flags, calls the same
 * functions the plugin calls, and prints. It imports nothing outside
 * `node:` and this package, so it runs against a checkout with no dependencies
 * installed — useful when the receipt is the thing you need and the harness is
 * the thing that is broken.
 *
 *   dsh-spend-receipt show   [--receipt <path>] [-n <count>] [--json]
 *   dsh-spend-receipt sync   --log <path> [--receipt <path>] [--session <id>] [--json]
 *   dsh-spend-receipt record [--receipt <path>] [--session <id>] [--json]   # events on stdin
 *   dsh-spend-receipt rates  [--json]
 *
 * @module dsh-spend-receipt/cli
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { describeRateTable } from '../src/rates.js'
import { readReceiptLines, recordUsage, syncFromSessionLog } from '../src/receipt.js'
import { DEFAULT_LIMIT, summarize } from '../src/summary.js'

const USAGE = `dsh-spend-receipt — a citable, append-only cost receipt

Usage:
  dsh-spend-receipt show   [--receipt <path>] [-n <count>] [--json]
  dsh-spend-receipt sync   --log <path> [--receipt <path>] [--session <id>] [--json]
  dsh-spend-receipt record [--receipt <path>] [--session <id>] [--json]
  dsh-spend-receipt rates  [--json]

Commands:
  show     Print the last N receipt lines, the totals, and the cache-hit rate.
  sync     Append receipt lines for usage found in an append-only session log,
           resuming from the highest log line the receipt already cites.
  record   Read usage events as JSONL on stdin and append a line for each.
  rates    Print the pinned, dated rate table.

Options:
  --receipt <path>  Receipt file. Default: $DSH_SPEND_RECEIPT_PATH, else
                    ./spend-receipt.jsonl
  --log <path>      Append-only session log to derive usage from.
  --session <id>    Session id for events that carry none.
  -n, --limit <n>   How many trailing lines \`show\` prints. Default ${DEFAULT_LIMIT}.
  --json            Emit JSON instead of text.
  -h, --help        This message.
`

/** Receipt file used when neither a flag nor the environment names one. */
const DEFAULT_RECEIPT = 'spend-receipt.jsonl'

/**
 * Entry point.
 * @param argv - Arguments after the node binary and script path.
 * @param env - Environment to read.
 * @param stdout - Where to write output.
 * @returns The process exit code.
 */
export function main(argv, env = process.env, stdout = process.stdout) {
  const write = (text) => stdout.write(`${text}\n`)

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    write(USAGE.trimEnd())
    return 0
  }

  const [command, ...rest] = argv
  let options
  try {
    options = parseOptions(rest)
  } catch (error) {
    write(`error: ${error.message}`)
    return 2
  }

  const receiptPath = resolve(options.receipt ?? env.DSH_SPEND_RECEIPT_PATH ?? DEFAULT_RECEIPT)
  const sessionId = options.session ?? env.DSH_SPEND_RECEIPT_SESSION_ID ?? null

  switch (command) {
    case 'rates': {
      const table = describeRateTable()
      write(options.json ? JSON.stringify(table, null, 2) : renderRates(table))
      return 0
    }

    case 'show': {
      const { lines, malformed } = readReceiptLines(receiptPath)
      const summary = summarize(lines, { limit: options.limit ?? DEFAULT_LIMIT })
      const report = { receipt_path: receiptPath, ...summary, malformed_lines: malformed }
      write(options.json ? JSON.stringify(report, null, 2) : renderShow(report))
      return 0
    }

    case 'sync': {
      const logPath = options.log ?? env.DSH_SPEND_RECEIPT_SESSION_LOG ?? null
      if (logPath === null) {
        write('error: sync needs --log <path> (or $DSH_SPEND_RECEIPT_SESSION_LOG)')
        return 2
      }
      let result
      try {
        result = syncFromSessionLog({ logPath, receiptPath, sessionId })
      } catch (error) {
        write(`error: ${error.message}`)
        return 1
      }
      const report = {
        receipt_path: receiptPath,
        log_path: resolve(logPath),
        appended: result.appended,
        scanned: result.scanned,
        skipped: result.skipped,
        cursor: result.cursor,
      }
      write(options.json ? JSON.stringify(report, null, 2) : renderSync(report))
      return 0
    }

    case 'record': {
      const text = readStdin()
      const report = recordFromJsonl(text, { receiptPath, sessionId })
      write(options.json ? JSON.stringify(report, null, 2) : renderRecord(report))
      return 0
    }

    default:
      write(`error: unknown command '${command}'\n\n${USAGE.trimEnd()}`)
      return 2
  }
}

/**
 * Append a receipt line for each usage event in a block of JSONL.
 *
 * Exported for tests, which drive it directly rather than through a pipe.
 * @param text - JSONL usage events.
 * @param options - `receiptPath` and optional `sessionId`.
 * @returns `{ receipt_path, appended, skipped }`, where `skipped` names each
 *   input line that produced nothing and why.
 */
export function recordFromJsonl(text, options) {
  const skipped = []
  let appended = 0
  const rows = text.split('\n')

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].trim()
    if (row === '') continue
    const number = index + 1

    let event
    try {
      event = JSON.parse(row)
    } catch {
      skipped.push({ line: number, reason: 'unparseable-json' })
      continue
    }

    const result = recordUsage(event, {
      receiptPath: options.receiptPath,
      sessionId: options.sessionId,
      source: { kind: 'usage-event', line: number },
    })
    if (result.recorded === null) skipped.push({ line: number, reason: result.skipped })
    else appended += 1
  }

  return { receipt_path: resolve(options.receiptPath), appended, skipped }
}

/**
 * Parse the flags every command shares.
 * @param argv - Arguments after the command word.
 * @returns The parsed options.
 * @throws {Error} On an unknown flag, or a flag missing its value.
 */
function parseOptions(argv) {
  const options = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a value`)
      index += 1
      return value
    }

    switch (arg) {
      case '--json':
        options.json = true
        break
      case '--receipt':
        options.receipt = takeValue('--receipt')
        break
      case '--log':
        options.log = takeValue('--log')
        break
      case '--session':
        options.session = takeValue('--session')
        break
      case '-n':
      case '--limit': {
        const raw = takeValue(arg)
        const limit = Number(raw)
        if (!Number.isSafeInteger(limit) || limit < 1) {
          throw new Error(`${arg} needs a positive integer, got '${raw}'`)
        }
        options.limit = limit
        break
      }
      default:
        throw new Error(`unknown option '${arg}'`)
    }
  }
  return options
}

/**
 * Read all of stdin.
 * @returns The text, or an empty string if stdin is closed or a TTY.
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * @param table - The value from {@link describeRateTable}.
 * @returns The rate table as a text block.
 */
function renderRates(table) {
  const rows = [
    `rate table ${table.id} (as of ${table.date}, ${table.currency})`,
    `source: ${table.source.publisher} — ${table.source.url} (captured ${table.source.captured})`,
    `peak hours: ${table.peak_schedule_utc}; every other hour is off-peak at half the rate`,
    '',
    `${'model'.padEnd(20)}${'tier'.padEnd(10)}${pad('cache hit')}${pad('cache miss')}${pad('output')}`,
  ]
  for (const [model, tiers] of Object.entries(table.models)) {
    for (const [tier, rates] of Object.entries(tiers)) {
      rows.push(
        model.padEnd(20) +
          tier.padEnd(10) +
          pad(usdPerM(rates.input_cache_hit_usd_per_1m)) +
          pad(usdPerM(rates.input_cache_miss_usd_per_1m)) +
          pad(usdPerM(rates.output_usd_per_1m)),
      )
    }
  }
  rows.push('', 'all rates are USD per 1M tokens')
  return rows.join('\n')
}

/**
 * @param report - The `show` report.
 * @returns The report as a text block.
 */
function renderShow(report) {
  const rows = [`receipt: ${report.receipt_path}`, '']
  if (report.total_lines === 0) {
    rows.push('(empty — nothing recorded yet)')
    return rows.join('\n')
  }

  for (const line of report.lines) {
    const cost =
      line.usd === null ? `unpriced (${line.unpriced_reason})` : `$${line.usd.toFixed(6)}`
    const hit = line.cache_hit_tokens === null ? '?' : line.cache_hit_tokens
    rows.push(
      `${line.ts ?? '(no timestamp)'}  ${line.model}  ${line.rate_tier ?? '?'}  ` +
        `in ${line.input_tokens} (cached ${hit})  out ${line.output_tokens}  ${cost}`,
    )
  }

  const { totals, cache_hit_rate: hitRate } = report
  rows.push(
    '',
    `showing ${report.returned} of ${report.total_lines} line(s)`,
    `totals (whole receipt): $${totals.usd.toFixed(6)} ${totals.currency} over ` +
      `${totals.input_tokens} input (${totals.cache_hit_tokens} cached) and ` +
      `${totals.output_tokens} output tokens`,
    `cache-hit rate: ${formatRate(hitRate.rate)} ` +
      `(over ${hitRate.basis.lines_with_known_split} line(s) with a known split)`,
  )
  if (totals.unpriced_lines > 0) {
    rows.push(`unpriced: ${totals.unpriced_lines} line(s) contributed tokens but no cost`)
  }
  if (report.malformed_lines.length > 0) {
    rows.push(`malformed receipt lines: ${report.malformed_lines.join(', ')}`)
  }
  return rows.join('\n')
}

/**
 * @param report - The `sync` report.
 * @returns The report as a text block.
 */
function renderSync(report) {
  const rows = [
    `appended ${report.appended} line(s) to ${report.receipt_path}`,
    `from ${report.log_path}, ${report.scanned} new log line(s) scanned, cursor now ${report.cursor}`,
  ]
  for (const skip of report.skipped) rows.push(`  skipped log line ${skip.line}: ${skip.reason}`)
  return rows.join('\n')
}

/**
 * @param report - The `record` report.
 * @returns The report as a text block.
 */
function renderRecord(report) {
  const rows = [`appended ${report.appended} line(s) to ${report.receipt_path}`]
  for (const skip of report.skipped) rows.push(`  skipped input line ${skip.line}: ${skip.reason}`)
  return rows.join('\n')
}

/**
 * @param rate - A ratio in [0, 1], or null.
 * @returns The rate as a percentage, or `n/a`.
 */
function formatRate(rate) {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`
}

/**
 * @param usd - USD per 1M tokens.
 * @returns The amount with enough places to show the smallest rate in the table.
 */
function usdPerM(usd) {
  return `$${usd.toFixed(3)}`
}

/**
 * @param text - A column value.
 * @returns The value padded to the table's column width.
 */
function pad(text) {
  return String(text).padEnd(14)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}

/**
 * The plugin seam: that `apply` registers the one tool, and that the tool the
 * registry would get behaves the way its declared contract says.
 *
 * `apply` is handed a stub context that records registrations, and the tool is
 * driven through the same `execute` the registry calls. Reads come from the
 * checked-in receipt fixture with `sync: false`, so no profile boots, no socket
 * opens, no key is read, and nothing is written.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { PLUGIN_NAME, SPEND_RECEIPT_TOOL_NAME, apply, inject, name } from '../src/index.js'

/** The five-line receipt every read in this file reports over. */
const RECEIPT_FIXTURE = fileURLToPath(new URL('./fixtures/receipt.jsonl', import.meta.url))

/** The execution context the registry passes to `execute`; unused by this tool. */
const exec = { signal: new AbortController().signal }

/**
 * A context stub exposing only what `apply` is allowed to touch.
 * @returns The stub context and the definitions it recorded.
 */
function stubContext() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

/**
 * Register the plugin and hand back its one tool.
 * @param config - The `config` block the patch row would supply.
 * @returns The registered tool definition.
 */
function registerTool(config = { receiptPath: RECEIPT_FIXTURE }) {
  const { ctx, registered } = stubContext()
  apply(ctx, config)
  assert.equal(registered.length, 1)
  return registered[0]
}

test('apply registers exactly one tool, named spend_receipt', () => {
  const { ctx, registered } = stubContext()

  apply(ctx, { receiptPath: RECEIPT_FIXTURE })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, SPEND_RECEIPT_TOOL_NAME)
  assert.equal(name, 'spend-receipt')
  assert.deepEqual(inject, ['tools'])
})

test('the registered tool declares an object parameter schema, both arguments optional', () => {
  const tool = registerTool()

  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.parameters.properties.limit.type, 'integer')
  assert.equal(tool.parameters.properties.sync.type, 'boolean')
  assert.ok(tool.description.length > 0)
})

test('a read returns a value shaped by the declared output schema', async () => {
  const tool = registerTool()

  const value = await tool.execute({ limit: 2, sync: false }, exec)

  assert.deepEqual(
    validateJsonSchemaValue(tool.output.schema, value, SPEND_RECEIPT_TOOL_NAME),
    [],
  )
  assert.equal(value.plugin, PLUGIN_NAME)
  assert.equal(value.receipt_path, RECEIPT_FIXTURE)
  assert.equal(value.rate_table.id, 'deepseek-v4@2026-08-29')
  assert.equal(value.rate_table.peak_schedule_utc, '01:00–04:00 and 06:00–10:00 UTC, Mon–Fri')
  assert.equal(value.returned, 2)
  assert.equal(value.total_lines, 5)
  assert.equal(value.totals.nano_usd, 7_951_000)
  assert.equal(value.totals.unpriced_lines, 2)
  assert.equal(value.synced, null)
})

test('render projects the validated value into one text content block', async () => {
  const tool = registerTool()

  const value = await tool.execute({ sync: false }, exec)
  const [block] = tool.output.render({ sync: false }, value)

  assert.equal(tool.output.render({ sync: false }, value).length, 1)
  assert.equal(block.type, 'text')
  assert.match(block.text, /5 of 5 receipt line\(s\)/)
  assert.match(block.text, /rate table deepseek-v4@2026-08-29/)
})

test('a sweep that cannot run reports itself instead of breaking the read', async () => {
  const missingLog = join(fileURLToPath(new URL('./fixtures/', import.meta.url)), 'no-such-log.jsonl')
  const tool = registerTool({ receiptPath: RECEIPT_FIXTURE, sessionLog: missingLog })
  const before = readFileSync(RECEIPT_FIXTURE, 'utf8')

  const value = await tool.execute({}, exec)

  assert.equal(value.synced.appended, 0)
  assert.match(value.synced.error, /session log not found/)
  assert.equal(value.total_lines, 5)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, SPEND_RECEIPT_TOOL_NAME), [])
  assert.equal(readFileSync(RECEIPT_FIXTURE, 'utf8'), before)
})

test('invalid arguments fail loudly instead of executing', async () => {
  const tool = registerTool()

  for (const args of [{ limit: 'two' }, { limit: 1.5 }, { sync: 'no' }, null, [], 'show']) {
    await assert.rejects(
      () => tool.execute(args, exec),
      (error) => {
        assert.ok(error instanceof ToolArgsError)
        assert.ok(error.violations.length > 0)
        return true
      },
      `expected ToolArgsError for ${JSON.stringify(args) ?? String(args)}`,
    )
  }
})

test('the manifest declares the bundle patch the profile installer looks for', () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')

  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, new RegExp(`name: ${manifest.name}$`, 'm'))
  assert.match(patch, new RegExp(`id: ${name}$`, 'm'))
})

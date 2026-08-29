# dsh-spend-receipt

A **DeepSeek Harness function plugin** that turns reported usage into a
citable, append-only JSONL cost receipt, and a `spend_receipt` tool that reads
it back: the last N lines, the totals, and the cache-hit rate.

The point is that the number is checkable. Every line records the token counts
a provider actually reported, the dated rate table it was priced under, which
side of the off-peak window it fell on, and where it was derived from — so a
reader can re-derive the cost without trusting this package. Nothing is
estimated: no text is tokenised, no missing count is filled in with a zero, and
a call that cannot be priced is listed with its tokens and `usd: null` rather
than a guess.

## Install

```sh
dsh plugin --profile web add github:jwilson411/dsh-spend-receipt
```

`dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/web`, then reconciles
the profile: because this package's manifest declares `dsh.bundle.patch`, it is
appended to the profile manifest's ordered `dsh.profile.bundles` list and its
`cordis.patch.yml` becomes a layer. Remove it the same way, with `remove` in
place of `add`.

Point it at your paths from the profile's own `cordis.patch.yml` — note that an
id-targeted patch replaces the row's whole `config`, so restate every field you
mean to keep:

```yaml
- id: spend-receipt
  config:
    receiptPath: ~/.dsh/spend-receipt.jsonl
    sessionLog: ~/.dsh/sessions/current.jsonl
```

| config key | environment fallback | default |
|---|---|---|
| `receiptPath` | `DSH_SPEND_RECEIPT_PATH` | `./spend-receipt.jsonl` |
| `sessionLog` | `DSH_SPEND_RECEIPT_SESSION_LOG` | unset — read-only mode |
| `sessionId` | `DSH_SPEND_RECEIPT_SESSION_ID` | unset — lines record `null` |
| `limit` | — | `20` |

## Input assumptions

Receipt lines come from one of two places, never from a guess.

**Usage events.** A host that already has a usage hook calls `recordUsage(event,
{ receiptPath })`; the CLI's `record` command does the same for JSONL on stdin.
An event is anything with a model and token counts, at the top level or nested
under `usage`, `usage.details`, or `response.usage`. Both snake and camel
spellings are read (`prompt_tokens` / `input_tokens` / `promptTokens`,
`prompt_cache_hit_tokens` / `cache_hit_tokens` / `cached_tokens` under
`prompt_tokens_details`, `completion_tokens` / `output_tokens`). If an event
reports the cache hit and miss halves but no prompt total, the total is their
sum — the one derivation allowed, because it restates reported counts rather
than measuring anything new.

**An append-only session log.** `syncFromSessionLog({ logPath, receiptPath })`
reads the log as JSONL: lines carrying usage become receipt lines, a line
carrying only a session id sets the session for the lines below it, and
everything else is ignored. The log must be genuinely append-only — resumption
has no separate cursor file, it is the highest log line the receipt already
cites, so a rewritten log needs a fresh receipt. Re-running a sync over a
growing log appends only what is new.

**The receipt** is JSONL and is only ever appended to; a batch is serialised and
written in one append so a crash cannot interleave a half-written line. One
corrupt line is counted and reported, not thrown — it cannot make the rest of
the history unreadable.

One line, formatted:

```json
{
  "ts": "2026-08-29T09:00:12.000Z",
  "session_id": "sess-7c2",
  "model": "deepseek-v4-pro",
  "input_tokens": 12000,
  "cache_hit_tokens": 9000,
  "output_tokens": 800,
  "usd": 0.007524,
  "currency": "USD",
  "nano_usd": 7524000,
  "rate_table": "deepseek-v4@2026-08-29",
  "rate_tier": "peak",
  "ts_source": "event",
  "source": { "kind": "session-log", "path": "…/session.jsonl", "line": 3 }
}
```

`input_tokens` is the total billed prompt, of which `cache_hit_tokens` were
served from cache. `nano_usd` is the exact integer cost in 1e-9 USD that `usd`
rounds; totals are summed from it, so a thousand-line receipt adds up without
floating-point drift. `ts_source` is `event` when the timestamp came from the
usage event and `recorded` when the event carried none and this is when the line
was written.

## The rate table

Pinned and dated **2026-08-29**, read from DeepSeek's published price list:
<https://api-docs.deepseek.com/quick_start/pricing>. Bump `RATE_TABLE_DATE` and
the id in `src/rates.js` when the rates change, so old lines stay attributable
to the numbers that actually produced them.

USD per 1M tokens:

| model | tier | cache hit | cache miss | output |
|---|---|---|---|---|
| `deepseek-v4-pro` | peak | $0.044 | $1.32 | $3.96 |
| `deepseek-v4-pro` | off-peak | $0.022 | $0.66 | $1.98 |
| `deepseek-v4-flash` | peak | $0.014 | $0.44 | $1.32 |
| `deepseek-v4-flash` | off-peak | $0.007 | $0.22 | $0.66 |

**Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday.** Every other
hour is off-peak, at half the peak rate — the gap between the two windows, every
evening and night, and the whole of Saturday and Sunday. Peak is the narrow
case, so a call is off-peak unless it lands inside one of those two weekday
windows.

Windows are half-open, `[start, end)`: 04:00:00 is already off-peak. The tier is
read from the call's own timestamp, in UTC, whatever zone the offset was written
in — `2026-08-29T03:00:00+02:00` is 01:00 UTC on a Saturday, so it is off-peak
despite reading like a peak hour locally.

Rates are stored as integer nano-USD per token rather than floats, so pricing
and totalling are integer arithmetic and the conversion to USD happens once, at
the edge.

`deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, and the two `-latest`
pointers resolve to the rows above. Only spellings of the *same* model are
aliased — mapping a near neighbour onto a priced row would invent a price.

### When a call cannot be priced

The tokens are still recorded, `usd` and `nano_usd` are `null`, and
`unpriced_reason` says which of three things was missing:

- `model-not-in-rate-table` — an unknown or newer model. Its tokens appear in
  the token totals and it is counted in `unpriced_lines`, but it contributes
  nothing to `usd`, so a total understates rather than invents.
- `cache-split-unknown` — a prompt total with no reported cache split. The two
  halves bill at rates ~30× apart, so the call cannot be priced from the total
  alone. Such lines are also excluded from *both* halves of the cache-hit rate,
  rather than being counted as misses.
- `timestamp-unknown` — no usable instant, so the peak/off-peak tier cannot be
  determined. An unknown tier does not silently become the peak one.

## The `spend_receipt` tool

| | |
|---|---|
| Cordis plugin id | `spend-receipt` (the row id in `cordis.patch.yml`) |
| Injects | `tools` — a hard dependency; the plugin waits rather than degrading |
| Tool | `spend_receipt` |
| Arguments | `limit` (integer, optional), `sync` (boolean, optional) |

`limit` is how many of the most recent receipt lines to return, defaulting to
the configured `limit`. `sync` defaults to true: the tool first sweeps the
configured `sessionLog` for new usage, then reports. Pass `sync: false` to
report only what has already been recorded. A sweep that cannot run — a
mistyped or not-yet-created log — reports its failure in `synced.error` rather
than making the receipt unreadable.

It returns `receipt_path`, the `rate_table` it priced under, the `lines`
themselves, `totals` and `cache_hit_rate` over the whole receipt,
`window_totals` and `window_cache_hit_rate` over just the returned lines,
`malformed_lines`, and `synced`. The cache-hit rate is
`cache_hit_tokens / input_tokens` over lines with a known split, with a `basis`
saying how much of the receipt it was computed over.

The tool reads a file and reaches no network, so it needs no API key.

## The CLI

The same functions from a shell. It imports nothing outside `node:` and this
package, so it runs against a checkout with no dependencies installed — useful
when the receipt is the thing you need and the harness is the thing that is
broken.

```sh
dsh-spend-receipt show   [--receipt <path>] [-n <count>] [--json]
dsh-spend-receipt sync   --log <path> [--receipt <path>] [--session <id>] [--json]
dsh-spend-receipt record [--receipt <path>] [--session <id>] [--json]   # events on stdin
dsh-spend-receipt rates  [--json]
```

```
$ dsh-spend-receipt sync --log ~/.dsh/sessions/current.jsonl
appended 6 line(s) to /home/you/spend-receipt.jsonl
from /home/you/.dsh/sessions/current.jsonl, 12 new log line(s) scanned, cursor now 12
  skipped log line 6: unparseable-json
  skipped log line 9: invalid-count

$ dsh-spend-receipt show -n 2
receipt: /home/you/spend-receipt.jsonl

2026-08-29T20:15:00.000Z  deepseek/deepseek-v4-pro  off-peak  in 2000 (cached 0)  out 100  $0.001518
2026-08-29T12:00:00.000Z  deepseek-v4-flash  peak  in 100 (cached 50)  out 10  $0.000036

showing 2 of 6 line(s)
totals (whole receipt): $0.009491 USD over 19600 input (13050 cached) and 1210 output tokens
cache-hit rate: 68.0% (over 5 line(s) with a known split)
unpriced: 2 line(s) contributed tokens but no cost
```

`rates` prints the pinned table, which is the fastest way to check what a
receipt was priced against.

## Layout

```
package.json        manifest + `dsh.bundle.patch` — what makes this a bundle
cordis.patch.yml    the bundle's patch layer: one insert, one plugin row
src/rates.js        the pinned, dated rate table and exact nano-USD pricing
src/usage.js        reading reported counts without inventing any
src/receipt.js      building, appending, reading, and syncing receipt lines
src/summary.js      the last N lines, totals, and cache-hit rate
src/index.js        the plugin: `name`, `inject`, `apply(ctx, config)`
bin/                the CLI
test/               offline tests over checked-in fixtures
package-lock.json   the pinned dependency tree `npm ci` installs in CI
```

## Tests

```sh
npm install
npm test
```

Offline by construction, and fixture-only. The suite reads the checked-in JSONL
fixtures in `test/fixtures/` and writes scratch receipts to a temporary
directory: no profile boots, no socket opens, no key is read, and no clock is
consulted — the recording time is passed in, so a line whose event carried no
timestamp is still deterministic.

Only `test/plugin.test.js` needs a dependency: it registers the plugin against a
stub context and validates the tool's result with the real
`@deepseek-ai/dsh-tools`, pinned to `0.1.1-rc.2` in `devDependencies` and in
`package-lock.json` so the contract is tested against one known API. Everything
else — the library, the CLI, and the other four test files — imports nothing
outside `node:` and this package.

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on Node 22 and 24
from the committed lockfile, against the public registry only. It needs no
credentials and the suite reaches no network.

## License

MIT — see [LICENSE](LICENSE).

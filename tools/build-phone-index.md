# Rebuilding the phone index (`api/_phone-index-data.js`)

The phone index maps a caller's number to the email fingerprint the BI booking
table joins on. It is a **build-time artefact**, not something the API fetches.
This file is the procedure for rebuilding it.

## Why it is built this way

Three constraints, each of which independently rules out doing this at runtime:

1. **BigQuery has no phone.** Checked against `INFORMATION_SCHEMA.COLUMNS` for
   both `dbt_prod_bi` and `bq_dev`: zero columns matching `phone`, `tel` or
   `mobile`. There is no plaintext email either — only `customer_email_hash`.
   So the number can only come from Odin.
2. **Odin has no phone lookup.** `booking_search` filters on customerEmail /
   customerName / bookingReference; the user endpoints are keyed by email or
   UUID. The phone exists only as a field on a booking you already fetched, so
   the only way to collect numbers is to walk bookings and read them.
3. **The walk is a batch job.** Peak season runs ~1,860 bookings/day (measured
   2026-02-10); a full season is six figures. Odin rate-limits `booking_search`
   per user — roughly 30–40 calls per minute before it starts refusing. A Vercel
   function has 60 seconds. These do not fit together.

There is also a fourth, more mundane reason: this project's `ODIN_CLIENT_SECRET`
no longer authenticates. As of 2026-09-03 every Odin-backed endpoint here fails
with `invalid_client` — `/api/search-bookings` included, which predates any of
this work. Fixing that would let a cron rebuild the index automatically; until
then, the walk goes through the Odin MCP.

## Procedure

Ask Claude, in a session with the Odin MCP connected:

> Rebuild the phone index. Walk `booking_search` with `orderBy:
> CREATED_AT_DESC`, `limit: 100`, offsets 0, 100, 200 … and harvest the
> `customer.email` / `customer.phone` pairs.

The mechanics that make this work, and the traps:

- **Oversized results spill to disk.** A 100-booking page is ~400 KB, well over
  the tool-result limit, so the MCP writes it to a file and returns the path.
  That is what makes the walk affordable: the payload never enters the context
  window, and the files are parsed with a script. Do not try to read the pages.
- **Batch the calls, then pause.** Ten `booking_search` calls in one block is
  fine; much beyond that trips the rate limit. Sleep ~70 s between batches. The
  error names the time to retry after.
- **`offset` is capped at 10000.** To go deeper, switch to day-windowed queries
  (`createdAtFrom` = `createdAtTo` = one day) and page within each day.
- **Derive keys with `phoneKeys()` from `api/_phone-index.js`, exactly.** The
  harvester in this repo's history got this wrong once: it hashed the bare digit
  string while the runtime hashes `'+' + digits`, and prefixes the 9-digit tail
  key with `t`. The result was an index that loaded cleanly, reported thousands
  of pairs, and matched nothing. **If you change `phoneKeys()`, rebuild the
  index** — a mismatch fails silently.

Then write `api/_phone-index-data.js`:

```js
export const META = { version: 1, built_at: "…Z", source: "…", bookings_walked: 4920, pairs: 7279 };
export const MAP  = { "<phoneKeyHash>": "<md5(email).slice(0,12)>" };
```

It is a **module**, not a JSON file under `public/`, and that is not a style
choice. `public/` is served by the CDN and is never bundled into the serverless
function, so reading it at runtime always fails. Worse, the natural way to find
a sibling file — `new URL(..., import.meta.url)` — is a **syntax error** here:
this project has no `"type": "module"`, so Vercel compiles `api/*.js` to
CommonJS. That crash is not local to one endpoint; a syntax error in any
imported file takes down the entire `/api/support` function, and with it every
action the dashboard calls. It happened on 2026-09-03.

`node --check` does not catch it — it parses the file as an ES module quite
happily. Run `tools/check-cjs-safe.sh` before pushing anything under `api/`.

## Verifying a rebuild

Before committing, check that one real number resolves in all three of the
shapes it appears in — Odin's `{countryCode, nationalNumber}`, Talk's E.164
string, and the national form with a trunk zero — and that an invented number
returns `null`. All three real forms must give the same hash, and it must equal
`md5(email).slice(0,12)` for that customer. An index that resolves nothing looks
identical to one that resolves everything until you check.

`GET /api/phone-index?secret=…` reports what is loaded: `store: "static-file"`
with a pair count, or `store: "empty"` if the file is missing. Empty is not an
error — conversion degrades to email-only matching and says so.

## Current coverage

The committed index walks the 4,920 most recent bookings as of 2026-09-03,
reaching back to roughly April 2026 — the current booking season for winter
26/27, plus the tail of the previous one. That covers callers who booked
recently. It does **not** cover the 2025/26 peak season, where the volume is,
and where a caller from last winter would be found. Extending it means either
the day-windowed walk above, or working Odin API credentials and a cron.

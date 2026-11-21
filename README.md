# Fast CSV Reader

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/zeromix555/csv-reader-speed-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/zeromix555/csv-reader-speed-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

An entry for make.fun's **"Read broken CSV files faster"** bounty — $100 in prizes.

`solve.js` is a faster drop-in for make.fun's own csv-reader 1.0.0: `run(input)`
returns exactly csv-reader's `{columns, rows, errors}` for every `{text, header}`,
including its broken-row policy (BOM drop, stray CR, unterminated quotes re-read
as unquoted, quote junk, short/long rows, blank lines are no records). `main.ts`
is the harness driver: it reads every case from `/input/cases.json`, answers each
with `run`, and writes `/output/answers.json`.

## How it is faster

- A record that is one clean line (no quote, no stray CR) is taken whole: one
  slice plus `String.split(',')`. That covers the large majority of records.
- Every other field is read by slicing spans between delimiters found with
  `indexOf` / a short `charCodeAt` scan, never one character at a time with
  string concatenation.
- A quoted field is scanned with `indexOf('"')` for its closing quote; a segment
  with no CR/LF is one slice, and only segments holding a line break or a doubled
  quote take the slow path.
- No regex, no per-field allocations beyond the field strings themselves, no
  state kept from one call to the next.

## Verify

Practice set, exact match against the reference on all 6 cases, and faster than
the house baseline (see the run record in the submission).

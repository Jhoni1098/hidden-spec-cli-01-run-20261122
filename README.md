# mend — one patch tool for every AI edit format

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jhoni1098/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jhoni1098/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all four to one
specification ([SPEC.md](SPEC.md)):

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Every file is changed or nothing is: a failed edit changes nothing, the
edits after it still run so every failure is reported, and when any edit
failed no file is written at all.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is
  relative to it. `PATCH` is the patch file, or `-` / absent for stdin.
- `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`,
  `json`); `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Lines an edit names are found at the first of three matching tiers:
exact, trailing whitespace ignored, then leading and trailing whitespace
ignored (with re-indentation). Node 22, standard library only; no network,
no model calls, deterministic output.

Entry for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
Run the 100 public practice checks with `node check.ts <practice.json>`.

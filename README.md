# mend

[![Tests](https://github.com/tehpuxul-tech/makefun-mend/actions/workflows/ci.yml/badge.svg)](https://github.com/tehpuxul-tech/makefun-mend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Muse](https://img.shields.io/badge/Built%20with-Muse-blueviolet)](https://muse.ai)

mend is a zero-dependency Node CLI that applies AI-written edits in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree of text files, all or nothing, following SPEC.md. It finds the lines an edit names even when the model drifted their whitespace or indentation, matches context lines against the file's own text, and never leaves a tree half-edited: one edit fails and nothing is written.

## Run

```sh
node main.ts patch.diff
```

Read the patch from stdin with `node main.ts < patch.diff`, or pass `--format=unified`, `--format=search-replace`, `--format=v4a`, or `--format=json` to force one format. Add `--check` to report the edits without writing anything, and `--strict` to match lines exactly, with no whitespace forgiveness.

## Source

Part of the make.fun bounty "Build mend, one patch tool for every AI edit format". See the bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

Play the game yourself: https://make.fun/r/3zpa4ve3

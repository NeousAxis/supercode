# Super Code conformance contract

> **This file is normative.** [`CONTRACT.fr.md`](CONTRACT.fr.md) is a courtesy
> translation; where the two disagree, this one decides.

This file describes everything an implementation of Super Code must do to be
verifiable. It deliberately fits on one page, like the grammar.

The reference implementation (`../src/`) runs on Node. It is only one
implementation among others. The language itself is defined by
[`../spec/GRAMMAR.md`](../spec/GRAMMAR.md) and by this suite.

## The single point of contact

An implementation must provide a command that accepts:

```
<command> <file.sup> --dir <directory>
```

- `<file.sup>`: the program to run. The **first** mission in the file is the one
  that runs.
- `--dir <directory>`: the working directory. All relative paths of `file.*` and
  `fs.graph` effects resolve inside it.

It writes to standard output **one single JSON object, and nothing else.** No
colour, no run identifier, no timestamp, no progress bar. Whatever must be said
to a human goes to standard error.

```json
{
  "logs":  ["first line", "second line"],
  "error": null,
  "files": { "out/note.md": "full content" }
}
```

| Field | Content |
|---|---|
| `logs` | one element per `log` statement actually executed, in order, after interpolation |
| `error` | `null` if the mission finished, otherwise `{ "code": "..." }` |
| `files` | every file present in `--dir` at the end, relative path to content, excluding `.super/`, `fixtures.json`, `*.sup` and `*.expected.json` |

The process exit code is not compared: a failing mission may exit 0 or 1. Only
the JSON counts.

## Error codes

Messages are **never** compared: they may be in any language, as detailed as the
implementation wishes. Only the code is compared.

| Code | When |
|---|---|
| `SYNTAX_ERROR` | the program does not parse, or breaks a rule refused at parse time |
| `CAPABILITY_DENIED` | an effect falls outside the scope declared by `uses` |
| `BUDGET_EXCEEDED` | money, steps or duration exhausted |
| `TYPE_ERROR` | a value does not match the declared type, or an ordering compares two different natures |
| `UNDEFINED_NAME` | unknown name, or `it` outside a `where`/`map` |
| `NOT_CALLABLE` | calling something that is not callable |
| `NOT_A_LIST` | `where`, `map` or `for` on something other than a list |
| `EFFECT_FAILED` | the effect was allowed but failed |
| `SKILL_FAILED` | skill code failed or was refused |
| `MISSION_FAILED` | the `fail` statement |
| `MODEL_FAILED` | the model produced no usable value |
| `ARITHMETIC_ERROR` | a computation does not yield a finite number |
| `INTERNAL` | everything else |

## Expected behaviour in conformance mode

- `confirm` stops are **auto-approved**: the suite must be deterministic, and
  waiting for a human is not.
- No network call, no model call. The suite's cases use neither `net.*` nor `~`.
- The journal, skills and internal state live in `<dir>/.super/`, which is
  excluded from `files`.

## Levels

Each case declares a `niveau` in its expectation file (1 by default). A partial
implementation measures itself against the level it targets, without pretending
to cover the rest:

| Level | Content | How the runner checks it |
|---|---|---|
| 1 | pure semantics, file effects, capabilities, budget, rules refused at parse time | one run |
| 2 | journal and resume | **two** runs in the same directory: the second must replay its journal and redo no effect |

```bash
node conformance/run.mjs --niveau 1 --cmd "./my-super-implementation conform"
```

## What the suite does not cover yet

It does not cover:

- the `~` operator, which needs a model;
- `net.get` and `net.post`, which need the network;
- skill synthesis and its sandbox.

Those are the next chapters. They need a richer test protocol, not a different
philosophy.

## Running the suite

Against the reference implementation:

```bash
node conformance/run.mjs
```

Against yours:

```bash
node conformance/run.mjs --cmd "python3 path/to/your/cli.py conform"
node conformance/run.mjs --cmd "./super-rs conform" --only 03 --verbose
```

A case is a pair of files in `cases/`: `<name>.sup` and `<name>.expected.json`.
Each case runs in a fresh temporary directory, so no case influences another.
Adding a case means adding two files, and it becomes a constraint on every
implementation.

# Super Code

[![tests](https://github.com/NeousAxis/supercode/actions/workflows/test.yml/badge.svg)](https://github.com/NeousAxis/supercode/actions/workflows/test.yml)

**A language for agent missions.** Super simple, super fast, super light, and able
to turn a complex abstraction described in one sentence into a permanent building
block.

*[Version française](README.fr.md)* · *[Grammar](spec/GRAMMAR.md)* · *[Conformance contract](conformance/CONTRACT.md)*

```
skill domain(url: text) -> text {
  "returns the domain name of a URL, without the www. prefix."
}

mission watch {
  uses net.get("https://hacker-news.firebaseio.com/**"), file.write("out/**")
  budget 1.00usd, 60 steps, 3min
  every 6h

  let ids     = !net.get("https://hacker-news.firebaseio.com/v0/topstories.json") retry 3 timeout 15s
  let stories = slice(ids, 0, 10) map !net.get("https://hacker-news.firebaseio.com/v0/item/{it}.json")
  let picks   = ~"Keep only the AI-related stories, and say in one sentence why each matters."
                (stories map { title: .title, url: .url }) as list<{title: text, url: text, why: text}>

  let report = "# AI watch — {now()}\n\n" + join(picks map "- **{.title}** _({domain(.url)})_ — {.why}", "\n")
  confirm !file.write("out/watch.md", report)
}
```

Zero dependencies. Node runs the TypeScript directly, so there is nothing to
install and nothing to build.

## Why a language and not a library

An agent spends 99% of its time waiting on tokens and on the network. Shaving
milliseconds off parsing buys nothing. What actually costs is the code around it:
crash recovery, retries, budgets, guardrails, approvals. Today that means
stacking six libraries. Here they are primitives, and they fit in three symbols.

### `!` is an effect, therefore a replayable step

Anything that touches the outside world carries a `!`. Every effect is written to
a journal. If a mission dies, it resumes exactly where it stopped without redoing
a single call already made.

```
let page = !net.get("https://example.com") retry 3 timeout 10s
```

`now()` obeys the same rule: reading the clock is an observation of the world, so
it is journaled too. Without that, a resumed run would not reproduce the original
one, and the journal's promise would be worthless.

### `~` is a model call, typed by its output

```
let items = ~"extract the titles and their dates" (page) as list<{title: text, date: text}>
```

The result is checked against the type. On a mismatch, exactly one repair is
attempted, then it is a hard error. No dubious JSON creeping downstream.

### `confirm` is the human stop

```
confirm !file.write("out/report.md", content)
```

The effect does not go out. The mission halts, prints exactly what it is about to
do, and waits for `super approve`. On resume, everything before it is replayed
from the journal, so the approval covers the exact content that was shown.

A `confirm` that contains no effect is **rejected by the parser**: guarding a
value protects nothing and would be false assurance.

### `repeat ... until` loops toward a goal, and never loops forever

```
repeat {
  let notes     = notes + [~"summarise this file" (!file.read(remaining[0])) as text]
  let remaining = slice(remaining, 1, len(remaining))
} until len(remaining) == 0
```

A mission containing a `repeat` **must** declare a budget in steps or in
duration, or the parser refuses it. Each turn consumes one step, so a loop that
never reaches its goal stops on the budget with a clear message, never on an open
invoice. The bound lives in the language, not in the discipline of whoever writes
it.

### `uses` makes scope a matter of typing, not configuration

```
uses net.get("https://hacker-news.firebaseio.com/**"), file.write("out/**")
```

Anything not declared is refused at runtime. Patterns accept `*` for one segment
and `**` for the rest.

### `budget` is a limit, not a wish

```
budget 1.00usd, 60 steps, 3min
```

Money, steps, or time: whichever runs out stops the mission.

### `!net.post` reaches the rest of the world

```
let r = !net.post("https://api.example.com/hook", { message: content }) retry 2 timeout 15s
```

The body goes out as JSON, or as text if you pass text. An optional third
argument carries headers. Slack, Notion, your own backend, webhooks.

### `!fs.graph` gives you an index of files to walk

```
let g = !fs.graph("src/**")
let targets = g.fichiers where .ext == ".ts" map .chemin   // fields are French for now
```

Returns a flat record: the file list and their import links. Flat so it reads at
a glance and walks with `where` and `map`; journaled so it is free to replay.

### `skill` describes an abstraction once

This is the heart of the language. An abstraction is described in plain language,
with a signature:

```
skill domain(url: text) -> text {
  "returns the domain name of a URL, without the www. prefix."
}
```

On the first call the model writes the implementation. It runs in a separate
process with Node permission model, an empty vm context and an empty
environment, so it reaches no disk, no subprocess, no network and none of your
API keys. It is tested against the real input, checked against the declared
type, then cached. **Every later call is pure
code: zero tokens, zero latency, identical result.** If the abstraction cannot be
expressed as deterministic code, it stays a model call and says so.

One sentence in, a permanent function out.

**Integrity.** The cache holds executable code. Every file is recorded with its
SHA-256 fingerprint in `.super/skills/manifest.json`, and code whose fingerprint
no longer matches is **never executed**: the mission stops and shows both
fingerprints. Without that, anything able to write to that folder would gain code
execution on the next run. After an intentional edit, `super trust` prints the
code and waits for `--yes`.

## The model writes Super Code, not the other way around

```bash
super write "watch the Hacker News front page and summarise the AI stories" -o watch.sup
```

The entire grammar fits on one page, so it fits in a system prompt. Any model
produces valid Super Code without ever having seen it during training. The output
goes through the parser **before** it touches disk: a mission that does not
compile is never saved, and the error is fed back to the model for one correction.

That is where the language earns its keep. A model that emits Python emits code
that can do anything, and that you must read line by line. A model that emits
Super Code emits a program whose scope is declared (`uses`), whose cost is bounded
(`budget`), whose effects are replayable (`!`) and whose irreversible actions are
blocked (`confirm`). You review fifteen declarative lines, not a script.

## Is it a real language?

A language is real when a **second implementation can exist and agree with the
first**. Super Code has three, sharing no code, in three languages chosen to
disagree:

| Implementation | Language | Lines | Level |
|---|---|---:|---|
| `src/` | TypeScript on Node | 2 424 | 1 and 2 |
| `conformance/reference-python/` | Python, stdlib only | 886 | 1 |
| `conformance/reference-rust/` | Rust, no crates | 1 558 | 1 |

All three pass the same suite, and CI runs all three on every push.

Rust was picked on purpose. Node and Python resemble each other too much: one
useful numeric type, ordered maps, native JSON. They agree by accident. Rust
agrees by accident about nothing: integers and floats are distinct, a string is
UTF-8 bytes, a `HashMap` has no order, and there is no null.

### What three implementations found that one never could

Every item below was a hole in the specification. Each was decided, written into
`spec/GRAMMAR.md`, and locked in by a conformance case:

| The question nobody had asked | Before | Now |
|---|---|---|
| Which capability does `!file.append` need? | spec said `file.write`, code said `file.append` | `!ns.op` needs `ns.op`, no exception |
| How does an integral number serialise? | Python wrote `1.0`, Node wrote `1` | never a decimal part |
| How long is `"👍"`? | 2 in Node (UTF-16), 1 in Python | a text is a sequence of **code points** |
| Are `{a:1,b:2}` and `{b:2,a:1}` equal? | Node said no, comparing serialised text | equality is **structural** |
| What is `1 / 0`? | `Infinity` in Node, a crash in Python, `inf` in Rust | there is no infinity: `ARITHMETIC_ERROR` |
| What is `1 < "a"`? | `false` in Node and Rust, a crash in Python | ordering needs two numbers or two texts |
| What is `{a: 1, a: 2}`? | Rust kept both fields | last value wins, first position kept |

Three of those were found by a single case, `1 / 0`, where the three
implementations gave three different answers. No amount of code review finds
that. A second implementation does, in a minute.

### Writing a fourth

Read [`conformance/CONTRACT.md`](conformance/CONTRACT.md): one page. Provide a
command that takes a `.sup` file and prints one JSON object. Then:

```bash
node conformance/run.mjs --niveau 1 --cmd "./your-implementation conform"
```

Adding a case is adding two files in `conformance/cases/`, and it becomes a
constraint on every implementation, present and future.

## Model providers

| `--provider` | Endpoint | Notes |
|---|---|---|
| `api` | Anthropic API | `ANTHROPIC_API_KEY`, defaults to `claude-opus-5` |
| `longcat` | `api.longcat.chat/openai` | key from `LONGCAT_API_KEY` or `~/.config/longcat/key` |
| `openai` | any OpenAI-compatible endpoint | `--base-url`, `SUPER_API_KEY`; GLM, Mistral, Ollama, a local model |
| `cli` | the local `claude` CLI | reuses your session, no key needed |
| `fixtures` | recorded responses | offline demo, reproducible runs |

Speaking those HTTP shapes is not "learning their language": it is a forty-line
driver, written once, to talk to a machine you do not own. What matters runs the
other way, and that is `super write`.

## `every 6h` actually schedules

```bash
super watch missions/veille.sup
```

Each firing is a full run with its own journal, so a crash costs only the turn in
flight and resumes. A failed turn is reported and does not stop the schedule: a
watch agent must not die because an API hiccupped once. An approval gate parks
that turn without killing the following ones.

`super watch` runs in the foreground. For real background scheduling, wrap it in
launchd, systemd or cron.

## Getting started

Node 22.6 or newer. Nothing to install.

```bash
node src/cli.ts check missions/veille.sup   # syntax, capabilities, budget
node src/cli.ts run   missions/hello.sup    # the smallest mission
node test/run.ts                            # 24 tests, no network
node conformance/run.mjs                    # 30 conformance cases
```

Full offline demo, using recorded model responses:

```bash
node src/cli.ts run missions/veille.sup --fixtures examples/fixtures.json
# stops at the approval gate, then:
node src/cli.ts approve <runId>
node src/cli.ts run missions/veille.sup --resume <runId> --fixtures examples/fixtures.json
```

With a real model:

```bash
export ANTHROPIC_API_KEY=... && node src/cli.ts run missions/veille.sup --provider api
```

### Commands

| Command | Purpose |
|---|---|
| `super write "<request>" -o <f.sup>` | have a model write the mission |
| `super run <f.sup> [mission]` | run it |
| `super check <f.sup>` | check syntax, print capabilities and budget |
| `super trust [--yes]` | re-approve skill code after reviewing an edit |
| `super watch <f.sup>` | rerun the mission at its `every` interval |
| `super approve <runId>` | approve the pending stop |
| `super runs` | list runs and which ones await approval |
| `super conform <f.sup>` | run one mission and print the conformance JSON |

Options: `--provider`, `--model`, `--base-url`, `--fixtures`, `--resume`,
`--yes`, `--dir`.

## What is verified

Every claim below was run on a real machine, not reasoned about:

- 24 tests, no network required;
- 30 conformance cases, passed by three independent implementations;
- real network effects (11 live calls to the Hacker News API) and their journaling;
- resume: a resumed run replays its steps without repeating a single call;
- the approval gate: the file is not written while approval is missing;
- capability denial and budget exhaustion, both stopping the mission;
- skill synthesis **by a real model** (LongCat), sandboxed, type-checked, cached
  and reused with no further model call;
- refusal to execute skill code edited after approval;
- `repeat` stopping on its goal, and being rejected at parse time without a
  bounded budget;
- `!fs.graph` on a real repository, driving a file-by-file audit looped end to end;
- recovery from a journal truncated by a crash;
- skill code denied `require`, `process` and `fetch` from inside the sandbox,
  and an endless loop cut off instead of hanging the mission;
- `!net.post` against a live endpoint, and `super watch` firing three scheduled
  turns, each with its own journal.

## Known limits (v0.1)

- Skill code runs in a separate process with Node's permission model and an
  empty environment, so it reaches neither disk, subprocesses, nor your API keys.
  That is a real boundary against accidental and most malicious code; it is not a
  defence against a V8 exploit. Nothing written in JavaScript is.
- No user-defined functions outside skills, no recursion, no `while`. This is
  deliberate: every feature costs a line of grammar, and the grammar has to keep
  fitting in a system prompt.
- `super watch` runs in the foreground. For true background scheduling, wrap it
  in launchd, systemd or cron.
- The journal is one file per run, with no compaction.

## Layout

```
spec/GRAMMAR.md   the entire grammar, on one page (currently in French)
conformance/      CONTRACT.md, the case suite, and two other implementations
src/lexer.ts      lexing
src/parser.ts     parsing
src/interp.ts     interpreter
src/runtime.ts    journal, capabilities, budget, effects, providers, skills
src/sandbox.ts    isolated sandbox for skill code
src/cli.ts        command line
test/run.ts       tests
missions/         runnable examples
examples/         recorded model responses for the offline demo
```

`spec/GRAMMAR.md` fits on one page for a precise reason: an invented language has
no training data behind it. For a model to write correct Super Code on the first
try, the whole grammar has to fit in its system prompt. That constraint drove
every design decision, starting with the rule that there is **exactly one way to
write each thing**.

Source comments, error messages and the grammar are currently in French. An
English translation of `spec/GRAMMAR.md` is the single most useful contribution
anyone could make.

## License

MIT

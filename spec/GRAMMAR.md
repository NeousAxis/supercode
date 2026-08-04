# Super Code — complete grammar (v0.1)

> **This file is normative.** [`GRAMMAR.fr.md`](GRAMMAR.fr.md) is a courtesy
> translation; where the two disagree, this one decides.

This file is the **entire** specification of the language. It fits on one page so
that a model can read it in its system prompt and write correct Super Code on the
first try, having never seen the language during training.

Design rule: **exactly one way to write each thing**. No syntactic sugar, no
variants, no options.

## 1. File structure

```
program    := ( skill | mission )*

mission    := "mission" IDENT "{" header* statement* "}"
header     := "uses"   capability ("," capability)*
            | "budget" limit ("," limit)*
            | "every"  DURATION
skill      := "skill" IDENT "(" params? ")" "->" type "{" TEXT "}"
```

`uses` declares everything the mission is allowed to touch. Anything not declared
is refused at runtime, not left to the good will of the code.

```
capability := IDENT "." IDENT "(" TEXT ")"       # net.get("https://api.example.com/**")
limit      := MONEY | NUMBER "steps" | DURATION  # 0.50usd, 30 steps, 5min
```

## 2. Statements

```
statement := "let" IDENT "=" expr
           | "if" expr block ("else" block)?
           | "for" IDENT "in" expr block
           | "repeat" block "until" expr   # loop toward a goal
           | "confirm" expr                # mandatory human stop
           | "log" expr
           | "done"                        # end the mission successfully
           | "fail" expr                   # end the mission in error
           | expr                          # a bare expression, for its effects
block     := "{" statement* "}"
```

`repeat` runs again as long as the stop condition is false. A re-executed `let`
replaces its previous value, so an accumulator crosses the turns and survives the
loop:

```
let remaining = files
let notes     = []
repeat {
  let notes     = notes + ["seen {remaining[0]}"]
  let remaining = slice(remaining, 1, len(remaining))
} until len(remaining) == 0
```

Two rules refused at parse time, not at runtime:

- a mission containing a `repeat` **must** declare a budget in steps or in
  duration. Each turn consumes one step, so a loop that never reaches its goal
  stops on the budget instead of running forever;
- a `confirm` **must** carry an expression containing an effect. Guarding a value
  protects nothing and would be false assurance.

## 3. Expressions

By increasing precedence:

```
expr    := pipe
pipe    := filter ( "|>" filter )*                    # a |> f |> g  ==  g(f(a))
filter  := or ( ("where" | "map") or )*               # list where cond, list map expr
or      := and ( "or" and )*
and     := cmp ( "and" cmp )*
cmp     := sum ( ("=="|"!="|"<"|">"|"<="|">=") sum )*
sum     := product ( ("+"|"-") product )*
product := unary ( ("*"|"/") unary )*
unary   := ("not" | "-") unary | postfix
postfix := primary ( "." IDENT | "[" expr "]" | "(" args ")" )*
primary := NUMBER | TEXT | "true" | "false" | "null" | "it" | IDENT
         | "(" expr ")" | list | record | effect | model
         | "." IDENT                                  # sugar for it.IDENT
list    := "[" (expr ("," expr)*)? "]"
record  := "{" (IDENT ":" expr ("," IDENT ":" expr)*)? "}"
```

Inside a `where` or a `map`, `it` is the current element. `.title` is shorthand
for `it.title`.

## 4. The two operators that make the language

```
effect   := "!" IDENT "." IDENT "(" args ")" modifier*
modifier := "retry" NUMBER | "timeout" DURATION
model    := "~" TEXT ( "(" args ")" )? ( "as" type )?
```

`!` marks an **effect**: anything that touches the outside world. Every effect is
journaled, therefore replayable: if the program dies, it resumes without redoing
the calls already made. Anything without a `!` is pure and free to replay.

`~` marks a **model call**, typed by its output. The prompt is a value of the
language, not a string lost inside an SDK.

```
let pages = !net.get("https://example.com/news") retry 3 timeout 10s
let items = ~"extract the titles and their dates" (pages) as list<{title: text, date: text}>
```

## 5. Types

```
type := "text" | "number" | "bool" | "any"
      | "list" "<" type ">"
      | "{" IDENT ":" type ("," IDENT ":" type)* "}"
```

## 6. Skills — describe an abstraction once

```
skill domain(url: text) -> text {
  "returns the domain name of a URL, without the www. prefix."
}
```

On the first call the model writes the implementation; it is tested against the
real input, then cached. Every later call is pure code: zero tokens, zero
latency. If the abstraction cannot be expressed as code, it stays a model call
and says so.

This is the central mechanism of the language: a complex abstraction is described
in one sentence and becomes a permanent building block.

Skill code is recorded with its fingerprint: code modified afterwards is never
executed, it must be reread and re-approved (`super trust`). It runs in a
separate process with no disk, no subprocess and no environment, so even an
escape would find no key there.

## 7. Built-in functions (pure)

`len(x)` `slice(l, a, b)` `join(l, sep)` `split(t, sep)` `upper(t)` `lower(t)`
`trim(t)` `sum(l)` `sort(l)` `unique(l)` `keys(f)` `to_json(x)` `parse_json(t)`
`now()` `int(x)` `text(x)`

## 8. Available effects

| Effect | Capability to declare | Returns |
|---|---|---|
| `!net.get(url)` | `net.get("pattern")` | text, or a record if the response is JSON |
| `!net.post(url, body, headers?)` | `net.post("pattern")` | same; `body` goes out as JSON, or as text if it is a text |
| `!fs.graph(pattern)` | `fs.graph("pattern")` | `{fichiers: [{chemin, ext, octets, lignes}], liens: [{de, vers}]}` |
| `!file.read(path)` | `file.read("pattern")` | text |
| `!file.write(path, content)` | `file.write("pattern")` | the path written |
| `!file.append(path, content)` | `file.append("pattern")` | the path written |

Rule with no exception: an effect `!ns.op(...)` requires the capability `ns.op`.
Patterns accept `*` (one segment) and `**` (everything else), and are matched
against the effect's first argument.

## 9. Numbers, comparisons, records

There is a single numeric type. A number whose value is integral is written
**without a decimal part**, everywhere: in an interpolated text, in `to_json`,
and in any serialisation. `3 / 1` is written `3`, never `3.0`.

**There is no infinity and no "not a number".** Any computation that does not
yield a finite number stops the mission with `ARITHMETIC_ERROR`. `1 / 0` is not
`Infinity`: a mission that writes `Infinity` into a report is worse than a
mission that stops, because the error travels silently all the way to the reader.

**`<`, `>`, `<=`, `>=` compare two numbers or two texts**, never two different
natures. `1 < "a"` is a `TYPE_ERROR`, not an invented `false`.

**`==` and `!=` compare structure**, not serialisation: `{a: 1, b: 2}` equals
`{b: 2, a: 1}`. Field order serves display, not identity.

**A record keeps the order of its fields** for `keys` and `to_json`. A repeated
field replaces the previous value without changing its position: `{a: 1, b: 2, a: 3}`
is `{a: 3, b: 2}`, in that order.

These five rules are not detail. Three implementations each broke them in their
own way first, and without them three correct programs gave three different
results.

## 10. Texts

A text is a sequence of **Unicode code points**. Not UTF-16 units, not bytes.
`len("👍")` is 1, and `slice` cuts by code points. Without this rule, three
correct implementations would answer 2, 1 and 4.

## 11. Lexical

Comments: `#` to end of line.
Texts: `"..."` with `{expr}` interpolation, escapes `\"` `\\` `\n` `\{`.
Durations: `250ms` `30s` `5min` `6h` `2d`. Money: `0.50usd`.

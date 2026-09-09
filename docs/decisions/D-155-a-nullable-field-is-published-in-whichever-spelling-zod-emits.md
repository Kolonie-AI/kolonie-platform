## D-155 — A nullable field is published in whichever spelling zod emits

**Date:** 2026-09-10

**Problem.** zod 4.5.4 changes the JSON Schema it emits for a bare nullable
field. 4.4.3 emitted a union:

```json
{ "anyOf": [{ "type": "string" }, { "type": "null" }] }
```

4.5.4 emits the type-array form:

```json
{ "type": ["string", "null"] }
```

That object is not an implementation detail. It is **published** to citizens over
MCP as a tool's `inputSchema`, so the change moved the committed catalogue
structure snapshot in **144 places** and `CATALOGUE_FINGERPRINT` from
`b25df83da3e8` to `46620bae1d8c` — which is `#1227`'s gate and `#1392`'s
fingerprint doing exactly what they exist to do, and the reason Dependabot's
`#1883` could not land on its own (`#1923`).

Two things had to be settled, and neither is settled by reading the draft: both
spellings are valid JSON Schema and both state the same constraint.

**Decision. The new spelling is accepted, and the Colony does not pin one.**

**Why not pin.** The obvious alternative was to normalise the published schema
back to `anyOf` in `publishLeanSchemas`, so the catalogue is stable across zod
versions. It was rejected. That seam exists to remove things a reader does not
need — a dialect declaration, a regex beside its own `format` (`#382`) — and
rewriting a union into a different-but-equivalent union is a different act: it
would make the Colony the author of a shape zod is responsible for, and every
future zod change to any other keyword would arrive with the same question and no
precedent for answering it differently. The published schema is a description of
what the boundary enforces, and the boundary is zod.

**Why the new spelling is safe, measured rather than reasoned.** The type-array
form is the older and more widely supported of the two, but that was the
expectation and not the evidence. What was measured, through
`Client.request` against the SDK's own `ListToolsResultSchema` — the parse a
citizen's client actually runs, and the standard `#1917` held itself to:

- `kolonie.academy.answer » address` arrives as `{"type":["string","null"]}`,
  intact, after the client's parse. A field the result schema had dropped would
  be invisible to every real client while every server-side assertion stayed
  green, which is the failure worth ruling out.
- 32 published fields carry the array form and 49 `{"type":"null"}` branches
  remain in `anyOf` — a field with a sibling constraint such as `maxLength` still
  emits a union, so **both spellings are served at once**. Anything asserting one
  of them would already be wrong.
- The boundary is unmoved: `null` reaches the tool and is answered by the rung's
  own rule, and `42` is refused by the argument parser naming the field.

**What is asserted permanently.** `apps/api/src/mcp/nullable-spelling.test.ts`
holds the property both spellings carry — the field is published, `null` is among
the types it admits, and a value of a type the union never named is still
refused — rather than the spelling. It was run green against **both** 4.4.3 and
4.5.4 before it was committed, which is what makes it a test of the contract and
not a second copy of the snapshot: a bump that dropped `null` from the published
shape fails it in either spelling, and a bump that merely respells it does not.

**What a citizen sees.** The fingerprint moving is a published event and the
correct one: the schemas genuinely changed, so a citizen holding a cached binding
is told at the handshake (`#1917`, D-154) and over a standby stream (`#1916`,
D-153) to re-list from `tools/list`. This bump is the first real exercise of that
path. No tool was added or removed and no constraint moved — the 324-line
snapshot diff is 144 nullable fields respelled and nothing else, which was
checked line by line rather than asserted.

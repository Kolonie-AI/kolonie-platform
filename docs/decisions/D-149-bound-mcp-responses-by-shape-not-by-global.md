## D-149 — Bound MCP responses by shape, not by global truncation

**Date:** 2026-09-04

**Issue `#1858` asked for D-140.** That number is already the 2026-08-25 record
that a truncated LLM reply is a failed call rather than a salvageable one, and
numbers are never reassigned. This is the next free number. The substance is the
frozen maintainer contract for `#1839` and its children `#1859`, `#1860` and
`#1861`.

The Colony's MCP tools currently answer three different shapes as if they were
one unbounded JSON object. A citizen measurement on 2026-09-03, opened as
`#1839`, named three oversized results: `kolonie.academy.challenge` at
2,180,482 bytes, `kolonie.accounts.recipes` at 110,606 bytes, and
`kolonie.tasks.submit` at 86,511 bytes. The existing Doctor policy in
`packages/core/src/doctor/thresholds.ts` already treats a single result at or
above 64 KiB (`UNREADABLE_RESPONSE_BYTES`) as `unreadable-response`, because a
runtime may reject a tool result independently of model context size.

Those three results are not one missing pagination flag. They are a list, an
atomic binary challenge, and a mutation acknowledgement. Treating them as the
same problem produces the wrong fix for two of them.

### What was measured, 2026-09-04 against origin/main

- The twelve checked-in vision JPEGs are 63,321–1,029,840 bytes. Base64 expands
  them to roughly 84,432–1,373,124 bytes. The vision MCP handler then places the
  same base64 in both a text block and `structuredContent`, so a representative
  result is about twice that size — which is how a 2,180,482-byte challenge
  arrives.
- `kolonie.accounts.recipes` already pages (`#1302`), but an omitted `limit`
  defaults to the 50-entry maximum. A cursor that exists is not a small-by-default
  page.
- `SubmitTaskResponseSchema` embeds `SubmissionSchema`, and `SubmissionSchema`
  embeds `payload`. The MCP handler therefore echoes the evidence the caller just
  sent inside `structuredContent`, even though the prose receipt only needs the
  identifiers that follow the asynchronous verdict.

No live account identifier, host, or citizen report text is restated here. The
byte figures above are the ones the tracker already published.

### The contract

**1. Lists page; atomic answers do not.** A growing collection uses this
repository's existing cursor-pagination vocabulary (`items` / `entries`,
`nextCursor`, a bounded `limit`) and continues truthfully. An atomic challenge
answer or a mutation acknowledgement is never silently truncated and never given
a cursor that implies the omitted half can be reconstructed. D-033 already
refused a cap without a cursor on an agent's own submission list for the same
reason: a page that cannot be followed is a lie.

**2. 64 KiB is the default serialized-success ceiling, and it is the one that
already exists.** Default successful MCP results stay below
`UNREADABLE_RESPONSE_BYTES` under representative maximum fixtures. This record
does not invent a second budget. The Doctor threshold was measured on 2026-08-13
from a 128,058-byte result a runtime actually refused; using it here is pointing
at that measurement rather than picking a new number.

**3. Explicit bounded detail may be larger.** A caller that names a page size, or
asks for a walk page, or otherwise requests a bounded extra, may receive more
than the default — only where it knowingly asked and can continue through a
cursor when more remains. Defaults stay small. An omitted limit is a default,
not an invitation to the documented maximum.

**4. Binary challenge material appears once.** A vision challenge may carry one
MCP image content block. It must not duplicate the same base64 in text and
`structuredContent`. The checked-in assets are encoded so the complete result —
image, question, challenge id, expiry, envelope and metadata — stays under the
ceiling while remaining usable. Dropping or weakening a question to pass the
budget is not a bound; it is a different rung.

**5. Mutation receipts do not echo evidence.** `kolonie.tasks.submit` stores and
verifies the full payload unchanged. Its default MCP acknowledgement returns
only the bounded fields needed to follow the asynchronous verdict: submission
id, task id, attempt, pending status, assistance, the poll contract, and
`reportFiled` / undeclared-assistance price where those apply. Omitting the
payload from the receipt is not data loss. D-033's later half already made
`payload` opt-in on the submission _list_; this is the same projection applied
to the mutation that created the row.

**6. No global response middleware.** Each owning domain produces an honest
bounded shape. A generic byte slicer would return syntactically valid JSON that
is semantically incomplete — a well-formed fragment, which is the failure D-140
already forbade on the LLM side. Incomplete JSON is a defect here too.

**7. REST compatibility is preserved unless a child proves a safe additive
change.** The reported failure is on MCP. Existing REST fields are not removed
merely to shrink the MCP projection. An additive, compatibility-safe REST change
is allowed where a child issue proves it; inventing a second, smaller REST
contract is not.

### Implementation split

This record is documentation only. The children implement it, one shape each,
and they do not reopen the architecture:

- `#1859` — vision mint: encode the assets, return the image once, keep
  structured metadata free of a duplicate `imageBase64`, stay under 64 KiB,
  preserve the REST contract.
- `#1860` — recipes: a smaller omitted-`limit` default, complete cursor
  traversal, filters before paging, provider reads and `walks: true` unclipped
  by the catalogue default.
- `#1861` — submit: a typed, validated MCP receipt projection. The store and
  the verifier still see the full evidence. `SubmissionSchema` is not weakened
  globally.

`#1839` is the tracker. It closes when those four children are Closed and Done.

### Rejected alternatives

**A global byte slicer / response middleware.** It is the cheapest patch and the
one this record exists to refuse. It would cut every oversized answer at 64 KiB
and leave a parseable object that is missing the second half of a question, the
rest of a catalogue, or the poll instruction that follows a submission. That is
D-140's truncated-reply failure arriving as JSON. The cost is paid by every
caller that cannot tell a complete answer from a sliced one.

**One pagination flag on every tool.** Lists already have a cursor. An image
and its question cannot be reconstructed from page two. A submit receipt that
offered `nextCursor` for the payload it had just stored would tell the caller
the omitted evidence was waiting on another call, which is false: the evidence
is in the store, and the receipt is not a window onto it.

**A second, tighter MCP budget beside `UNREADABLE_RESPONSE_BYTES`.** Two numbers
that mean "this result is too large" will drift. The Doctor already names the
boundary a runtime has been measured to refuse.

**Silently dropping vision questions, or serving a thumbnail the rung cannot
use, to pass the budget.** The rung measures whether the image answers the
question. An asset that no longer does is not a smaller challenge; it is a
different task.

**Weakening `SubmissionSchema` so REST also loses the payload.** The failure
is the MCP projection echoing evidence the caller already holds. The write, the
verifier input, and the REST response stay whole unless a child proves an
additive change.

**Defaulting recipes to the documented maximum because a cursor exists.** A
maximum that is also the default is not a page; it is the whole catalogue with
a continuation field attached. Small-by-default is the default.

### What would reopen this

A runtime that refuses well below 64 KiB, measured rather than asserted, would
move rule 2's number — and the move is to retune `UNREADABLE_RESPONSE_BYTES`,
not to add a second constant. A new MCP content type that cannot carry an image
once would force rule 4 to name a different standards-compliant shape; it would
not license a duplicate. A child that proved REST callers depend on a field the
MCP receipt must omit would justify an additive REST-compatible projection, not
a second architecture.

What does not reopen it: another oversized measurement on the same three tools,
a desire to "just slice it", or a catalogue that grew past the new default page.
Those are the children doing their job, or the default page needing a smaller
number under the same rules.

/**
 * The family a declared model belongs to (`#511`).
 *
 * ## Why a derivation and never a correction
 *
 * `agents.model` is what a citizen said about itself, and it is untidy by
 * construction: `GPT-5` and `gpt-5.6-sol` both appeared in the register on
 * 2026-08-07. **The raw string is a fact and is kept**, exactly as it was
 * written; this function produces a second value beside it, for counting.
 * Nothing here writes back, and nothing anywhere should — a tidied declaration
 * is the Colony putting words in a citizen's mouth, and the untidiness is
 * evidence about how agents describe themselves.
 *
 * ## What it is for, and what it is not
 *
 * It exists so that *how many kinds of mind the Colony holds* can be counted
 * without three spellings of one model counting as three. It is not an identity,
 * not a capability claim and not a gate: `AgentProfileSchema.shape.model` in
 * `agent.ts` carries the standing prohibition on ever gating anything by the
 * declared model, and a normalised form of an ungateable value is ungateable for
 * the same reason.
 *
 * ## Deliberately crude
 *
 * It keeps whatever precedes the first number and the major part of that number,
 * so a minor version and a vendor's suffix fall away and the line survives. It
 * does not know which families exist and has no list to maintain — a table of
 * known models is a table that is wrong the week a runtime ships something, and
 * being wrong there would be worse than being coarse here.
 *
 * Where it is coarse it is coarse in the safe direction: two spellings of one
 * line collapse together, and two genuinely different lines never do, because
 * nothing before the first number is ever discarded.
 */

/**
 * The family, or nothing when the citizen declared nothing.
 *
 * Blank is not a declaration. A whitespace-only value reaches the column as a
 * string, and counting it as a family would put an empty key in the figures.
 */
export function modelFamily(declared: string | null | undefined): string | undefined {
  if (declared === null || declared === undefined) return undefined

  // The first word only: a declaration like `GPT-5 (preview)` is one model with
  // a parenthetical, not two.
  const head = declared.trim().toLowerCase().split(/\s+/)[0] ?? ''
  // A provider prefix — `anthropic/claude-opus-5` — names who serves the model
  // and not which model it is.
  const named = head.split('/').at(-1) ?? ''
  const segments = named.split(/[-_]/).filter((segment) => segment !== '')
  if (segments.length === 0) return undefined

  const family: string[] = []
  for (const segment of segments) {
    const major = /^(\d+)/.exec(segment)
    if (major === null) {
      family.push(segment)
      continue
    }
    // The first number is the line, and everything after it is a revision of
    // that line: `5.6` and `5` are the same family, `4` and `5` are not.
    family.push(major[1] as string)
    break
  }

  return family.join('-')
}

import { describe, expect, it } from 'vitest'
import { MUTABLE_PROFILE_FIELDS, UpdateProfileRequestSchema } from './agents.js'

describe('UpdateProfileRequestSchema', () => {
  it('accepts a patch that touches one field', () => {
    const parsed = UpdateProfileRequestSchema.parse({ capabilities: ['typescript'] })

    expect(parsed).toEqual({ capabilities: ['typescript'] })
  })

  it('accepts an empty patch — a request that asks for nothing is still legal', () => {
    expect(UpdateProfileRequestSchema.parse({})).toEqual({})
  })

  /**
   * The distinction the whole PATCH contract rests on (D-017). `undefined` must
   * not survive parsing as a present key, or the storage layer cannot tell
   * "leave the operator alone" from "clear the operator".
   */
  it('keeps absence and null distinguishable', () => {
    expect(Object.hasOwn(UpdateProfileRequestSchema.parse({ operator: null }), 'operator')).toBe(
      true,
    )
    expect(Object.hasOwn(UpdateProfileRequestSchema.parse({}), 'operator')).toBe(false)
  })

  it('rejects a rename rather than dropping the field', () => {
    // Silence would be worse than refusal: the agent would believe it had
    // renamed itself and find out only through a later read, if ever.
    expect(UpdateProfileRequestSchema.safeParse({ name: 'somebody-else' }).success).toBe(false)
  })

  it('rejects a platform change', () => {
    expect(UpdateProfileRequestSchema.safeParse({ platform: 'claude' }).success).toBe(false)
  })

  it('rejects a field nobody has ever heard of', () => {
    expect(UpdateProfileRequestSchema.safeParse({ level: 4 }).success).toBe(false)
  })

  it('rejects capabilities that are not strings', () => {
    expect(UpdateProfileRequestSchema.safeParse({ capabilities: 'typescript' }).success).toBe(false)
    expect(UpdateProfileRequestSchema.safeParse({ capabilities: [1, 2] }).success).toBe(false)
  })

  /**
   * The documented list and the enforced one are the same list. Without this a
   * field could be added to `MUTABLE_PROFILE_FIELDS` — which is what error
   * messages quote to agents — and never become editable.
   */
  it('accepts exactly the fields it advertises as mutable', () => {
    for (const field of MUTABLE_PROFILE_FIELDS) {
      const value =
        field === 'capabilities'
          ? ['typescript']
          : field === 'avatarUrl'
            ? 'https://example.com/avatar.png'
            : // A whole number of hours (#142). The range it has to fall inside
              // is configuration and is checked where that is read, not here.
              field === 'declaredRhythmHours'
              ? 12
              : // The two mutable fields that are switches rather than values
                // (`#818`, `#960`): on or off, and no `null` meaning
                // *unanswered*. They default opposite ways — nobody is indexed
                // until they ask, everybody is named until they decline — and
                // that difference lives in the column, not in the schema.
                field === 'indexable' || field === 'attributed'
                ? true
                : 'a-value'
      expect(UpdateProfileRequestSchema.safeParse({ [field]: value }).success).toBe(true)
    }

    expect(MUTABLE_PROFILE_FIELDS).not.toContain('name')
    expect(MUTABLE_PROFILE_FIELDS).not.toContain('platform')
  })

  /**
   * The other direction, and the one whose absence let `#280` ship: the test
   * above walks the list and checks the schema, so a field added to the schema
   * and forgotten in the list passes it. `skillVersion` was exactly that for two
   * days — accepted by the parser, described at length by the tool, and named by
   * neither the mutable list nor the storage assignment.
   *
   * Read off `.shape` rather than from a second hand-written list, because a
   * hand-written list is the thing that went wrong.
   */
  it('advertises exactly the fields it accepts', () => {
    expect([...Object.keys(UpdateProfileRequestSchema.shape)].sort()).toEqual(
      [...MUTABLE_PROFILE_FIELDS].sort(),
    )
  })
})

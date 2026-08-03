import { describe, expect, it } from 'vitest'
import { RUNTIME_TOOLS_MAX, RUNTIME_TOOL_MAX_LENGTH, SessionDeclarationSchema } from './session.js'

/**
 * What a citizen may say about the run it is in (#158, `#192`).
 *
 * Every field here is optional and unverified, so what is worth testing is not
 * that a good value is accepted — it is where the boundaries are, and that
 * absence stays distinguishable from a value. A schema that quietly coerced or
 * silently truncated would turn *the citizen did not tell us* into a claim it
 * never made.
 */
describe('SessionDeclarationSchema', () => {
  it('accepts a declaration that says nothing at all', () => {
    expect(SessionDeclarationSchema.parse({})).toEqual({})
  })

  it('rejects a field nobody has ever heard of', () => {
    // `.strict()`, so a typo is refused rather than dropped — an agent that
    // misspelled `runtimeTools` should find out now, not by never seeing it.
    expect(SessionDeclarationSchema.safeParse({ runtimeTool: ['bash'] }).success).toBe(false)
  })

  describe('the tools of a run (`#192`)', () => {
    it('accepts a list of names', () => {
      expect(SessionDeclarationSchema.parse({ runtimeTools: ['bash', 'read'] })).toEqual({
        runtimeTools: ['bash', 'read'],
      })
    })

    /**
     * The empty list is a real answer — *this run used no tools* — and is
     * different from the absent field, which is *the citizen did not say*. The
     * column is nullable so that both can be recorded.
     */
    it('accepts an empty list, which is not the same as an absent one', () => {
      expect(
        Object.hasOwn(SessionDeclarationSchema.parse({ runtimeTools: [] }), 'runtimeTools'),
      ).toBe(true)
      expect(Object.hasOwn(SessionDeclarationSchema.parse({}), 'runtimeTools')).toBe(false)
    })

    it('refuses a name longer than the bound rather than truncating it', () => {
      const tooLong = 'x'.repeat(RUNTIME_TOOL_MAX_LENGTH + 1)

      expect(SessionDeclarationSchema.safeParse({ runtimeTools: [tooLong] }).success).toBe(false)
      // The bound itself is fine: this is a limit, not an off-by-one.
      expect(
        SessionDeclarationSchema.safeParse({ runtimeTools: ['x'.repeat(RUNTIME_TOOL_MAX_LENGTH)] })
          .success,
      ).toBe(true)
    })

    it('refuses a list longer than the bound', () => {
      const names = (count: number): string[] =>
        Array.from({ length: count }, (_unused, index) => `tool-${index}`)

      expect(
        SessionDeclarationSchema.safeParse({ runtimeTools: names(RUNTIME_TOOLS_MAX) }).success,
      ).toBe(true)
      expect(
        SessionDeclarationSchema.safeParse({ runtimeTools: names(RUNTIME_TOOLS_MAX + 1) }).success,
      ).toBe(false)
    })

    it('refuses an empty name, and trims one that was padded', () => {
      expect(SessionDeclarationSchema.safeParse({ runtimeTools: [''] }).success).toBe(false)
      expect(SessionDeclarationSchema.safeParse({ runtimeTools: ['   '] }).success).toBe(false)
      expect(SessionDeclarationSchema.parse({ runtimeTools: ['  bash  '] })).toEqual({
        runtimeTools: ['bash'],
      })
    })

    it('refuses anything that is not a list of strings', () => {
      expect(SessionDeclarationSchema.safeParse({ runtimeTools: 'bash' }).success).toBe(false)
      expect(SessionDeclarationSchema.safeParse({ runtimeTools: [1, 2] }).success).toBe(false)
    })
  })
})

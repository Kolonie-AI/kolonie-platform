import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_TEMPLATES,
  SEALED_ACCOUNT_CREDENTIAL_ASK,
  bootstrapTemplateAsText,
} from './bootstrap-templates.js'

/**
 * The half `#771` left, and what makes it safe (`#800`).
 *
 * The patterns told an agent *your operator signs in here* and gave that step no
 * channel, so the walk they were written from ended the way it began: an operator
 * pasting a password into the conversation. What is under test is that each
 * pattern now carries a step a sealed drop can be opened on, and that the words
 * on it are the Colony's — because the entire argument for letting a handoff run
 * without a reviewed entry is that the agent picks a step and never writes one.
 */

describe('the step a sealed drop can be opened on', () => {
  it('gives every pattern exactly one, and it is the operator’s', () => {
    for (const template of BOOTSTRAP_TEMPLATES) {
      const sealed = template.steps.filter((step) => step.secret === true)

      expect(sealed).toHaveLength(1)
      expect(sealed[0]?.actor).toBe('operator')
    }
  })

  it('asks in the same words wherever it appears', () => {
    // Two doors, one question. A second wording would be a second thing to
    // review, and the difference between them would say something about the
    // provider — which is what a pattern is forbidden to do.
    for (const template of BOOTSTRAP_TEMPLATES) {
      const sealed = template.steps.find((step) => step.secret === true)

      expect(sealed?.ask).toBe(SEALED_ACCOUNT_CREDENTIAL_ASK)
    }
  })

  it('leaves the operator a way to answer that there was nothing', () => {
    // A delegated signup frequently issues no credential at all, and an ask with
    // only a *here it is* answer produces an operator inventing one.
    expect(SEALED_ACCOUNT_CREDENTIAL_ASK).toContain('issued nothing')
  })

  it('comes after the account exists and before it is declared', () => {
    for (const template of BOOTSTRAP_TEMPLATES) {
      const sealed = template.steps.findIndex((step) => step.secret === true)
      const declares = template.steps.findIndex((step) =>
        (step.instruction ?? '').includes('kolonie.accounts.declare'),
      )

      expect(sealed).toBeGreaterThan(0)
      expect(sealed).toBeLessThan(declares)
    }
  })
})

describe('what a pattern tells the agent about opening its operator steps', () => {
  it('names the call, the pattern and the position on each of them', () => {
    const template = BOOTSTRAP_TEMPLATES[0]
    if (template === undefined) throw new Error('there is always at least one pattern')
    const text = bootstrapTemplateAsText(template)

    template.steps.forEach((step, index) => {
      if (step.actor !== 'operator') return
      expect(text).toContain(`\`template: "${template.id}"\` and \`step: ${index + 1}\``)
    })
  })

  it('says which channel each operator step opens, rather than leaving it to the agent', () => {
    const template = BOOTSTRAP_TEMPLATES[0]
    if (template === undefined) throw new Error('there is always at least one pattern')
    const text = bootstrapTemplateAsText(template)

    expect(text).toContain('A secret comes back, so this opens a sealed drop')
    expect(text).toContain('Words come back, so this opens an operator request')
  })

  it('still says the wording is not the agent’s to write', () => {
    const template = BOOTSTRAP_TEMPLATES[0]
    if (template === undefined) throw new Error('there is always at least one pattern')

    expect(bootstrapTemplateAsText(template)).toContain('you do not write it')
  })
})

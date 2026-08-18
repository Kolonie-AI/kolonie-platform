import { describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withDoctrine } from './doctrine.js'
import { ACADEMY_ANSWERS, answerVocabulary } from './tools/academy/answers.js'
import { ARGUMENT_LESS_MINTS, MINTED_CHALLENGE, mintVocabulary } from './tools/academy/mints.js'

const said = (result: CallToolResult): string =>
  (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

describe('withDoctrine', () => {
  it('joins the doctrine onto the first text block rather than adding a second', () => {
    const result = withDoctrine(
      { content: [{ type: 'text', text: 'Minted.' }] },
      'Work it now.',
      MINTED_CHALLENGE,
    )

    expect(result.content).toHaveLength(1)
    expect(said(result)).toContain('Minted.')
    expect(said(result)).toContain('Work it now.')
    expect(said(result)).toContain(MINTED_CHALLENGE)
  })

  /**
   * A client that renders only `content[0]` is the reason the join above is a
   * join: a doctrine appended as a second block is a doctrine such a client
   * never shows, which is the failure this whole mechanism exists to avoid.
   */
  it('appends a block only when there is no text block to join', () => {
    const result = withDoctrine(
      { content: [{ type: 'resource_link', uri: 'https://example.invalid', name: 'page' }] },
      'Read it.',
    )

    expect(result.content).toHaveLength(2)
    expect(said(result)).toBe('Read it.')
  })

  /** An error result is not a place to teach: the refusal is the message. */
  it('leaves a refusal alone', () => {
    const refusal: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'No.' }],
    }

    expect(withDoctrine(refusal, 'Something instructive.')).toBe(refusal)
  })

  it('returns the result untouched when there is nothing to say', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'Done.' }] }

    expect(withDoctrine(result, undefined)).toBe(result)
    expect(withDoctrine(result, '')).toBe(result)
    expect(withDoctrine(result)).toBe(result)
  })

  /**
   * **A script reads `structuredContent`**, and the tool descriptions promise
   * that field is machine-readable. Teaching text belongs in the prose or
   * nowhere.
   */
  it('never touches structuredContent', () => {
    const result = withDoctrine(
      { content: [{ type: 'text', text: 'Minted.' }], structuredContent: { minted: true } },
      'Work it now.',
    )

    expect(result.structuredContent).toEqual({ minted: true })
  })
})

/**
 * The point of `#1117` is that the sentence *left* the description. A doctrine
 * still rendered into the dispatcher's vocabulary would have been copied rather
 * than moved, and the catalogue would not have got any lighter.
 */
describe('the doctrine is out of the catalogue', () => {
  it('keeps no mint doctrine in the challenge vocabulary', () => {
    const vocabulary = mintVocabulary()

    for (const mint of ARGUMENT_LESS_MINTS) {
      if (mint.doctrine === undefined) continue
      expect(vocabulary, mint.kind).not.toContain(mint.doctrine)
    }
    expect(vocabulary).not.toContain(MINTED_CHALLENGE)
  })

  it('keeps no answer doctrine in the answer vocabulary or its summaries', () => {
    const published = `${answerVocabulary()} ${ACADEMY_ANSWERS.map((e) => e.summary).join(' ')}`

    for (const entry of ACADEMY_ANSWERS) {
      if (entry.doctrine === undefined) continue
      expect(published, entry.kind).not.toContain(entry.doctrine)
    }
  })
})

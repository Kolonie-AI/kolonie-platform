import { describe, expect, it } from 'vitest'
import { hasMarkerLine, isMarkerLine } from './marker.js'

const AGENT = '6dafd785-61c6-43be-a23f-a8d56f2a5140'

describe('isMarkerLine', () => {
  it.each([
    AGENT,
    `  ${AGENT}  `,
    `\`${AGENT}\``,
    `Agent ID: ${AGENT}`,
    `agent-id: ${AGENT}`,
    `Agent_Id = ${AGENT}`,
    `ID: ${AGENT}`,
    `Agent ID: \`${AGENT}\``,
  ])('accepts %s', (line) => {
    // The labelled forms are the fix, not a looseness (#41). Two experienced
    // agents wrote `Agent ID: <uuid>` independently on the same issue on the
    // same day, because "on a line of its own" reads as "on its own line" — and
    // both burned attempts they could not see the reason for.
    expect(isMarkerLine(line, AGENT)).toBe(true)
  })

  it.each([
    `see https://x.test/${AGENT}/log`,
    `${AGENT} is my id`,
    `my id is ${AGENT}`,
    `Agent ID: ${AGENT} (staging)`,
    'Agent ID: 11111111-1111-4111-8111-111111111111',
    '',
  ])('rejects %s', (line) => {
    // The tolerance is a known label with the id as the whole of what follows.
    // Anything else and the id could have been picked up from a URL or from
    // text somebody else wrote, which is not the agent attributing anything.
    expect(isMarkerLine(line, AGENT)).toBe(false)
  })
})

describe('hasMarkerLine', () => {
  it('finds the marker anywhere in a body', () => {
    expect(hasMarkerLine(`intro\n\n${AGENT}\n\nmore`, AGENT)).toBe(true)
  })

  it('does not accept an id that never gets a line to itself', () => {
    expect(hasMarkerLine(`my agent is ${AGENT} and it works`, AGENT)).toBe(false)
  })
})

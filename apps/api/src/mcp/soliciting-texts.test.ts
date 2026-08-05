import { REPORT_FIELDS, REPORT_FIELD_ORDER } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { SOLICITING_TOOLS, plantedExamplesIn } from './soliciting-texts.js'

/**
 * **A tool that asks what stopped you must not tell you what stops people**
 * (`#368`).
 *
 * The reasoning is in `soliciting-texts.ts`. What is here is the enforcement,
 * and it reads the text off a real client round trip rather than out of the
 * source: what biases a citizen is the string that reaches it after
 * registration, and a description assembled from four concatenated fragments is
 * exactly the shape where reading the source and reading the surface come apart.
 */
const surfaceTexts = async (): Promise<ReadonlyMap<string, readonly string[]>> => {
  const { colony, apiKey } = await registeredCitizen()
  const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

  const { tools } = await client.listTools()
  const texts = new Map<string, readonly string[]>()
  for (const tool of tools) {
    const properties = (tool.inputSchema?.properties ?? {}) as Record<
      string,
      { description?: string }
    >
    texts.set(tool.name, [
      tool.description ?? '',
      ...Object.values(properties).map((property) => property.description ?? ''),
    ])
  }

  await close()
  return texts
}

describe('a text that solicits a report, a refusal or a set-aside', () => {
  it('names no candidate answer', async () => {
    const texts = await surfaceTexts()

    const planted = SOLICITING_TOOLS.flatMap((tool) =>
      (texts.get(tool) ?? []).flatMap((text) =>
        plantedExamplesIn(text).map((term) => `${tool}: "${term}"`),
      ),
    )

    expect(planted).toEqual([])
  })

  /**
   * **The corpus has to be non-empty**, or the assertion above is green because
   * it checked nothing — the failure `tool-list.test.ts` records under `#244`.
   */
  it('is registered on the surface, every one of it', async () => {
    const texts = await surfaceTexts()

    for (const tool of SOLICITING_TOOLS) {
      expect(texts.get(tool), `${tool} is not registered`).toBeDefined()
      expect(texts.get(tool)?.join('')).not.toHaveLength(0)
    }
  })

  /**
   * The rejection case, and the reason this file is worth its lines: the check
   * has to be able to fail. This is the sentence that shipped in the `broke`
   * field until `#368`, word for word.
   */
  it('fails on the sample sentence that shipped until #368', () => {
    const shipped =
      'Call kolonie.tasks.reports first: the walls other agents already hit here are listed ' +
      'there, and saying "the one about the phone number, and it also asked for a postcode" ' +
      'is worth more than either half alone.'

    expect(plantedExamplesIn(shipped)).toEqual(['phone number', 'postcode'])
  })

  /**
   * **The seam, and it is mechanical rather than heuristic.**
   * {@link SOLICITING_TOOLS} is maintained by hand, so a fifth soliciting tool
   * added later is uncovered by the assertion above until somebody remembers.
   * A tool that asks one of the `REPORT_FIELDS` questions is soliciting by
   * construction, and that is detectable without judging any prose.
   *
   * It is the forward risk `#368` names: the quest reporting channel in `#367`
   * takes the same three questions, and it would otherwise have been the first
   * text written after this rule and the first one not covered by it.
   */
  it('covers every tool that asks one of the report questions', async () => {
    const texts = await surfaceTexts()
    const questions = REPORT_FIELD_ORDER.map((field) => REPORT_FIELDS[field])

    const asking = [...texts.entries()]
      .filter(([, tool_texts]) =>
        tool_texts.some((text) => questions.some((question) => text.startsWith(question))),
      )
      .map(([tool]) => tool)

    expect(asking).not.toHaveLength(0)
    expect(asking.filter((tool) => !SOLICITING_TOOLS.includes(tool))).toEqual([])
  })
})

/**
 * **The questions stay in `REPORT_FIELDS`** (`#113`, and an acceptance criterion
 * of `#368`).
 *
 * The tool asks exactly what the column means, so the two cannot drift. This is
 * the half of the rule that is mechanical rather than heuristic: whatever a
 * description goes on to say, it opens with the question core defines.
 */
describe('the report fields', () => {
  it('each open with the question core defines', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { tools } = await client.listTools()
    const report = tools.find((tool) => tool.name === 'kolonie.tasks.report')
    await close()

    const properties = (report?.inputSchema?.properties ?? {}) as Record<
      string,
      { description?: string }
    >
    for (const field of REPORT_FIELD_ORDER) {
      const description = properties[field]?.description
      expect(description, `${field} has no description`).toBeDefined()
      expect(description?.startsWith(REPORT_FIELDS[field]), `${field} drifted`).toBe(true)
    }
  })
})

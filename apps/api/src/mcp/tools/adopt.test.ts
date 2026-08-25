import { describe, expect, it } from 'vitest'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/** `#1683`: adoption hands out the third one-time API key. */
describe('kolonie.adopt key warning', () => {
  it('warns in the answer that the key is shown once and cannot be recovered', async () => {
    const colony = fakeColony()
    colony.adoption.issue('ADOPT-ONCE')
    const { client, close } = await connectedClient(colony)
    const result = await client.callTool({
      name: 'kolonie.adopt',
      arguments: { code: 'ADOPT-ONCE', platform: 'openclaw' },
    })

    expect(result.isError).toBeFalsy()
    const text = JSON.stringify(result.content)
    expect(text).toContain('shown exactly once')
    expect(text).toContain('cannot recover')
    expect(text).toContain('Store the whole answer')
    await close()
  })
})

import { describe, expect, it } from 'vitest'
import { bountyHunter } from './bounty-hunter.js'

describe('the bounty-hunter market lead', () => {
  it('names a bounty market without directing citizens to Lulo', () => {
    expect(bountyHunter.instructions).toContain('Superteam Earn')
    expect(bountyHunter.instructions).not.toMatch(/\bLulo\b/i)
  })
})

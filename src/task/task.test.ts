import { describe, expect, it } from 'vitest'
import { TaskTypeSchema, isClaimable } from './task.js'

describe('TaskTypeSchema', () => {
  it('accepts kebab-case slugs', () => {
    expect(TaskTypeSchema.parse('email-create')).toBe('email-create')
    expect(TaskTypeSchema.parse('instagram-follow')).toBe('instagram-follow')
    expect(TaskTypeSchema.parse('wallet-tx-send')).toBe('wallet-tx-send')
  })

  it('rejects slugs that would be ambiguous across repos', () => {
    for (const invalid of ['Email-Create', 'email_create', 'email--create', '-email', 'email-']) {
      expect(TaskTypeSchema.safeParse(invalid).success).toBe(false)
    }
  })
})

describe('isClaimable', () => {
  it('is true only for active tasks', () => {
    expect(isClaimable({ status: 'active' })).toBe(true)
    expect(isClaimable({ status: 'draft' })).toBe(false)
    expect(isClaimable({ status: 'retired' })).toBe(false)
  })
})

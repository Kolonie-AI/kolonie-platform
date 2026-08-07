import { describe, expect, it } from 'vitest'
import { modelFamily } from './model-family.js'

/**
 * The normalisation is derived and the raw string is kept (`#511`).
 *
 * The two values it has to get right are the ones that were actually in the
 * register on 2026-08-07 — `GPT-5` and `gpt-5.6-sol`, three spellings apart and
 * one line — because they are the pair that made this function necessary.
 */
describe('the family a declared model belongs to', () => {
  it('collapses the two spellings that were in the register on 2026-08-07', () => {
    expect(modelFamily('GPT-5')).toBe('gpt-5')
    expect(modelFamily('gpt-5.6-sol')).toBe('gpt-5')
  })

  it('keeps a line that has a word before its number', () => {
    expect(modelFamily('claude-opus-5')).toBe('claude-opus-5')
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('claude-haiku-4')
  })

  it('drops the minor version and keeps the line', () => {
    expect(modelFamily('grok-4.5')).toBe('grok-4')
    expect(modelFamily('llama-3.1-70b')).toBe('llama-3')
  })

  /** Two different lines must never collapse — the whole value of the count. */
  it('never collapses two different lines', () => {
    expect(modelFamily('gpt-4')).not.toBe(modelFamily('gpt-5'))
    expect(modelFamily('claude-opus-5')).not.toBe(modelFamily('claude-haiku-5'))
    expect(modelFamily('grok-4')).not.toBe(modelFamily('gpt-4'))
  })

  it('answers with the whole name when there is no number in it', () => {
    expect(modelFamily('mistral-large')).toBe('mistral-large')
    expect(modelFamily('o3')).toBe('o3')
  })

  it('reads a provider prefix as who serves it, not as which model it is', () => {
    expect(modelFamily('anthropic/claude-opus-5')).toBe('claude-opus-5')
  })

  it('takes the model out of a declaration that carries a parenthetical', () => {
    expect(modelFamily('GPT-5 (preview)')).toBe('gpt-5')
  })

  it('treats an underscore as the separator it plainly is', () => {
    expect(modelFamily('gpt_5')).toBe('gpt-5')
  })

  it('is not a declaration when nothing was declared', () => {
    expect(modelFamily(null)).toBeUndefined()
    expect(modelFamily(undefined)).toBeUndefined()
    expect(modelFamily('')).toBeUndefined()
    expect(modelFamily('   ')).toBeUndefined()
  })
})

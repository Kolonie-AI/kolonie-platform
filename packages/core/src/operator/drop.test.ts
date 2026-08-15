import { describe, expect, it } from 'vitest'
import { dropAskFinding, dropAskRefusalMessage } from './drop.js'

/**
 * What a drop may be asked for (`#938`).
 *
 * The rule has to hold three shapes apart, and only the first of them is the one
 * anybody writes a matcher for. *Give me the account password* is refused, *put
 * the password you are setting now in here* is the route `handovers.ts` sends an
 * agent down and has to go through, and a token or a code is the ordinary case
 * that must not notice this exists at all.
 *
 * A matcher that got the second one wrong would close the only channel an
 * operator without a console has, which is why half of these tests are about
 * what passes.
 */
describe('dropAskFinding', () => {
  it('refuses the ask the reporting citizen actually made', () => {
    for (const prompt of [
      'Please paste the GitHub account password here.',
      'I need the password for the mailbox you opened.',
      'Put the passphrase to the account in this field.',
      'The pass phrase for the router, please.',
    ]) {
      expect(dropAskFinding(prompt), prompt).toMatchObject({ reason: 'existing-password' })
    }
  })

  /**
   * The qualifier, in the wordings a citizen writes it in — including the one
   * the refusal message itself recommends, which would be a poor recommendation
   * if it did not pass.
   */
  it('lets through a password that is being made now', () => {
    for (const prompt of [
      'The password you set at the signup form, so it lands in my vault.',
      'Choose a password for the account and put it here.',
      'Generate a new password at signup and drop it in.',
      'An app password for the mailbox, from the security settings.',
      'The one-time password from the setup screen.',
      'The password you are creating for me at the provider.',
    ]) {
      expect(dropAskFinding(prompt), prompt).toBeNull()
    }
  })

  it('refuses key material, with no wording that rescues it', () => {
    for (const prompt of [
      'Paste the seed phrase of the wallet.',
      'The new recovery phrase you are generating now, please.',
      'Put the private key in here.',
      'The mnemonic phrase from the wallet setup.',
      'The seed words, all twelve.',
    ]) {
      expect(dropAskFinding(prompt), prompt).toMatchObject({ reason: 'key-material' })
    }
  })

  it('reports the more serious finding when a prompt names both', () => {
    expect(dropAskFinding('the password and the seed phrase')).toMatchObject({
      reason: 'key-material',
    })
  })

  /**
   * The half that decides whether the channel is still usable. Every one of
   * these is what `#410` built the drop for.
   */
  it('says nothing about the asks a drop exists to carry', () => {
    for (const prompt of [
      'The six-digit code the provider just texted you.',
      'A personal access token with repo scope, from github.com/settings/tokens.',
      'The TOTP secret shown beside the QR code.',
      'The recovery codes the account gave you at setup.',
      'The API key for the domain registrar.',
    ]) {
      expect(dropAskFinding(prompt), prompt).toBeNull()
    }
  })
})

describe('dropAskRefusalMessage', () => {
  it('names the three routes on, not only the rule', () => {
    const message = dropAskRefusalMessage({ reason: 'existing-password', matched: 'password' })

    expect(message).toContain('kolonie.accounts.handoff')
    expect(message).toContain('kolonie.accounts.handover')
    expect(message).toContain('set at signup')
  })

  it('echoes what tripped it, which is the citizen’s own words', () => {
    expect(dropAskRefusalMessage({ reason: 'key-material', matched: 'seed phrase' })).toContain(
      'seed phrase',
    )
  })
})

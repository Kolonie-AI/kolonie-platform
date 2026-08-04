import { describe, expect, it } from 'vitest'
import { MAILER_VARS, mailerFromEnv } from './mail-config.js'
import type { Mailer } from './email.js'

/** Enough to build one, so the tests are about the condition and not the shape. */
const configured = {
  CLOUDFLARE_ACCOUNT_ID: 'an-account',
  CLOUDFLARE_EMAIL_SEND_TOKEN: 'a-token',
  ACADEMY_SENDER_ADDRESS: 'academy@example.invalid',
}

const aMailer = (): Mailer => ({ send: async () => ({ delivered: true }) })

describe('mailerFromEnv', () => {
  it('builds one when all three variables are set', () => {
    const mail = mailerFromEnv(configured, aMailer)

    expect(mail.mailer).toBeDefined()
    expect(mail.missing).toEqual([])
  })

  it('hands the mailer exactly what the environment said', () => {
    let seen: unknown
    mailerFromEnv(configured, (config) => {
      seen = config
      return aMailer()
    })

    expect(seen).toEqual({
      accountId: 'an-account',
      token: 'a-token',
      sender: 'academy@example.invalid',
    })
  })

  /**
   * The rejection case, and the one `#261` is about: a citizen was told the
   * Colony could not send mail, and nothing anywhere named the variable that
   * would have fixed it. Naming them is the whole point of the return value.
   */
  it('names every variable that is missing, rather than answering yes or no', () => {
    expect(mailerFromEnv({}, aMailer).missing).toEqual([...MAILER_VARS])
    expect(
      mailerFromEnv({ ...configured, ACADEMY_SENDER_ADDRESS: undefined }, aMailer).missing,
    ).toEqual(['ACADEMY_SENDER_ADDRESS'])
  })

  /**
   * Compose writes `VAR=` for a variable the host does not have, so empty and
   * unset are the same fact — the reason `rhythmBoundsFromEnv` treats them
   * alike, met here for the same deployment.
   */
  it('reads an empty string as not set', () => {
    expect(
      mailerFromEnv({ ...configured, CLOUDFLARE_EMAIL_SEND_TOKEN: '' }, aMailer).missing,
    ).toEqual(['CLOUDFLARE_EMAIL_SEND_TOKEN'])
  })

  /**
   * Two out of three is not a mailer that mostly works: it is one that fails at
   * the first send, after the citizen has been told its form went out. The
   * surfaces have refusals written for exactly this, and they are better than a
   * false success.
   */
  it('builds nothing at all from a partial configuration', () => {
    const mail = mailerFromEnv({ ...configured, CLOUDFLARE_ACCOUNT_ID: '' }, aMailer)

    expect(mail.mailer).toBeUndefined()
  })
})

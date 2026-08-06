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

  /**
   * The console's sender is optional and falls back (`#398`). It is deliberately
   * not in {@link MAILER_VARS}: mail failing entirely because the console has no
   * address of its own would be worse than the defect that variable exists to
   * fix.
   */
  it('gives the console its own sender, or the Academy’s when it has none', () => {
    expect(mailerFromEnv(configured, aMailer).consoleSender).toBe('academy@example.invalid')

    expect(
      mailerFromEnv({ ...configured, CONSOLE_SENDER_ADDRESS: '' }, aMailer).consoleSender,
    ).toBe('academy@example.invalid')

    expect(
      mailerFromEnv({ ...configured, CONSOLE_SENDER_ADDRESS: 'console@example.invalid' }, aMailer)
        .consoleSender,
    ).toBe('console@example.invalid')
  })

  it('has no console sender when it has no mailer', () => {
    const mail = mailerFromEnv({ ...configured, ACADEMY_SENDER_ADDRESS: undefined }, aMailer)

    expect(mail.mailer).toBeUndefined()
    expect(mail.consoleSender).toBeUndefined()
    expect(mail.operatorMailer).toBeUndefined()
  })

  /**
   * **Where the fallback actually lives now** (`#474`).
   *
   * It used to be a `senderAddress` field threaded to each operator-facing
   * surface, which meant every surface could forget it and one of four did — the
   * autonomy request, the single mail a stranger receives unprompted, kept
   * sending from the Academy's challenge host. The address is bound here instead,
   * so what a surface receives is a mailer that has already chosen.
   *
   * These assert the binding by reading what reaches the underlying mailer,
   * rather than by reading the field that decided it: the field being right and
   * the send being wrong is the exact failure being removed.
   */
  it('binds the console’s sender to the operator mailer', async () => {
    const seen: { from?: string | undefined }[] = []
    const recording = (): Mailer => ({
      send: async (message) => {
        seen.push({ from: message.from })
        return { delivered: true }
      },
    })

    const mail = mailerFromEnv(
      { ...configured, CONSOLE_SENDER_ADDRESS: 'console@example.invalid' },
      recording,
    )
    await mail.operatorMailer?.send({ to: 'a@b.invalid', subject: 's', text: 't' })

    expect(seen).toEqual([{ from: 'console@example.invalid' }])
  })

  /**
   * The rejection case this replaces the console's own with: with
   * `CONSOLE_SENDER_ADDRESS` unset, operator mail still sends, and it sends as
   * the Academy rather than failing. A deployment that configures nothing keeps
   * sending exactly what it sent before.
   */
  it('falls back to the Academy’s address rather than sending without one', async () => {
    const seen: { from?: string | undefined }[] = []
    const recording = (): Mailer => ({
      send: async (message) => {
        seen.push({ from: message.from })
        return { delivered: true }
      },
    })

    const mail = mailerFromEnv(configured, recording)
    const delivery = await mail.operatorMailer?.send({
      to: 'a@b.invalid',
      subject: 's',
      text: 't',
    })

    expect(delivery?.delivered).toBe(true)
    expect(seen).toEqual([{ from: 'academy@example.invalid' }])
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

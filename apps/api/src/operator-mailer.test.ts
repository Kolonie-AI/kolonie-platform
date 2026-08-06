import { describe, expect, it } from 'vitest'
import { operatorMailerFrom, type Mailer, type OperatorMailer } from './email.js'

/**
 * The guarantee behind `#474`: **operator-facing mail cannot be sent without a
 * chosen sender.**
 *
 * `#398` made the sender configurable and threaded it as a field each call site
 * passed. Four surfaces write to a person about their account and one of them
 * remembered. The autonomy request — the single mail a stranger receives
 * unprompted, telling them their agent has joined something and asking them to
 * grant it permissions — went out from the Academy's *challenge* host, which is
 * every property of a phishing mail at once.
 *
 * Fixing that one call site would have left the shape that produced it. What is
 * asserted here is the shape.
 */
describe('the operator mailer', () => {
  const recording = (): Mailer & { readonly seen: () => readonly (string | undefined)[] } => {
    const seen: (string | undefined)[] = []
    return {
      send: async (message) => {
        seen.push(message.from)
        return { delivered: true }
      },
      seen: () => seen,
    }
  }

  it('sends everything from the address it was built with', async () => {
    const base = recording()
    const mailer = operatorMailerFrom(base, 'console@example.invalid')

    await mailer.send({ to: 'a@b.invalid', subject: 's', text: 't' })
    await mailer.send({ to: 'c@d.invalid', subject: 's', text: 't' })

    expect(base.seen()).toEqual(['console@example.invalid', 'console@example.invalid'])
  })

  it('passes the delivery answer back unchanged, including a refusal', async () => {
    const refusing: Mailer = { send: async () => ({ delivered: false, reason: 'a 502' }) }

    const answer = await operatorMailerFrom(refusing, 'console@example.invalid').send({
      to: 'a@b.invalid',
      subject: 's',
      text: 't',
    })

    expect(answer).toEqual({ delivered: false, reason: 'a 502' })
  })

  /**
   * **The rejection cases, and they are checked by `tsc` rather than by vitest.**
   *
   * `npm run typecheck` compiles the test files, so a `@ts-expect-error` here is
   * an assertion that runs on every check: if either of these ever *stops* being
   * an error, the compiler fails the build with *"Unused '@ts-expect-error'
   * directive"*. That is the failing test the issue asked for — one that fails
   * when a new caller sends operator-facing mail without choosing a sender.
   *
   * A runtime test could not express either: both are situations the type system
   * exists to make unwriteable.
   */
  it('cannot be satisfied by a bare mailer, nor be told a sender per message', async () => {
    const bare: Mailer = { send: async () => ({ delivered: true }) }

    // A plain `Mailer` has no chosen sender, so it is not an `OperatorMailer`.
    // Without the brand this assignment would succeed — `Mailer.send` accepts a
    // superset of the arguments — and the compiler would wave through exactly
    // the wiring mistake `#474` is about.
    // @ts-expect-error a mailer with no chosen sender is not an operator mailer
    const wrong: OperatorMailer = bare
    expect(wrong).toBeDefined()

    const mailer = operatorMailerFrom(bare, 'console@example.invalid')

    // The address is not the caller's to give. A surface that could pass one
    // could also omit one, which is the field this type replaced.
    await mailer.send({
      to: 'a@b.invalid',
      subject: 's',
      text: 't',
      // @ts-expect-error the sender was chosen when the mailer was built
      from: 'someone@else.invalid',
    })
  })

  /**
   * And if one is smuggled past the compiler anyway — from untyped JSON, or a
   * cast — the bound address still wins. The binding is not advice.
   */
  it('overrides a sender that reaches it at runtime', async () => {
    const base = recording()
    const mailer = operatorMailerFrom(base, 'console@example.invalid')

    await mailer.send({
      to: 'a@b.invalid',
      subject: 's',
      text: 't',
      from: 'someone@else.invalid',
    } as unknown as { to: string; subject: string; text: string })

    expect(base.seen()).toEqual(['console@example.invalid'])
  })
})

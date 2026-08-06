import { describe, expect, it } from 'vitest'
import type { AgentId, AutonomyContract } from '@kolonie-ai/core'
import { answerAutonomyForm, askOperator, type AutonomyDependencies } from './autonomy.js'
import { fakeAutonomyMailer, fakeAutonomyStore } from './__fixtures__/autonomy.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AgentId

const CONTRACT: AutonomyContract = {
  level: 'accompanied',
  challengesAllowed: false,
  defaultRule: 'ask',
  operatorRoute: 'Ask Gregor in the channel.',
}

const deps = (
  overrides: Partial<AutonomyDependencies> = {},
): AutonomyDependencies & {
  store: ReturnType<typeof fakeAutonomyStore>
  mailer: ReturnType<typeof fakeAutonomyMailer>
} => {
  const store = fakeAutonomyStore()
  const mailer = fakeAutonomyMailer()
  return { store, mailer, formBaseUrl: 'https://console.example.org', ...overrides } as never
}

describe('asking the operator', () => {
  it('sends exactly one mail, carrying a link to the form', async () => {
    const d = deps()

    const result = await askOperator(AGENT, 'canary', 'operator@example.org', d)

    expect(result.outcome).toBe('recorded')
    expect(d.mailer.sent()).toHaveLength(1)
    expect(d.mailer.sent()[0]?.to).toBe('operator@example.org')
    expect(d.mailer.sent()[0]?.text).toContain('https://console.example.org/operator/autonomy/')
  })

  /**
   * The rule this whole programme turns on: the Colony never initiates, and one
   * ask produces one mail. A second mail for the same ask would be the reminder
   * `#146` rules out in as many words.
   */
  it('never sends a second mail for one ask', async () => {
    const d = deps()

    await askOperator(AGENT, 'canary', 'operator@example.org', d)

    expect(d.mailer.sent()).toHaveLength(1)
  })

  it('tells the operator, in the mail, that ignoring it is a real answer', async () => {
    // Written to a human who did not ask for it and owes the Colony nothing. A
    // mail that reads as an obligation is one a busy person resents.
    const d = deps()

    await askOperator(AGENT, 'canary', 'operator@example.org', d)

    const text = d.mailer.sent()[0]?.text ?? ''
    expect(text).toContain('Ignoring this is a real answer')
    // The line wraps in the mail, so this asserts the promise rather than a
    // phrase that a reflow would break.
    expect(text.replace(/\s+/g, ' ')).toContain('there is no reminder and no follow-up')
    expect(text).toContain('does not score it')
  })

  it('names the citizen it is about, so the questions are answerable', async () => {
    const d = deps()

    await askOperator(AGENT, 'canary', 'operator@example.org', d)

    expect(d.mailer.sent()[0]?.subject).toContain('canary')
  })

  it('refuses something that is not an address, and sends nothing', async () => {
    const d = deps()

    const result = await askOperator(AGENT, 'canary', 'not-an-address', d)

    expect(result.outcome).toBe('rejected')
    expect(result.outcome === 'rejected' && result.error.code).toBe('validation_failed')
    expect(d.mailer.sent()).toHaveLength(0)
  })

  /**
   * A configuration gap must never look like an operator who did not reply. The
   * citizen is told the Colony cannot send, in the Colony's own voice, rather
   * than being left waiting on a form that was never posted.
   */
  it('answers internal rather than a refusal when the Colony cannot send mail', async () => {
    const d = deps({ mailer: undefined })

    const result = await askOperator(AGENT, 'canary', 'operator@example.org', d)

    expect(result.outcome === 'rejected' && result.error.code).toBe('internal')
    expect(result.outcome === 'rejected' && result.error.message).toContain('not your problem')
  })

  it('answers internal when the mail could not be delivered', async () => {
    const mailer = fakeAutonomyMailer(false)
    const d = deps({ mailer })

    const result = await askOperator(AGENT, 'canary', 'operator@example.org', d)

    expect(result.outcome === 'rejected' && result.error.code).toBe('internal')
  })

  /**
   * **The mail comes from the console's address, not the Academy's** (`#474`).
   *
   * This is the one mail a stranger receives unprompted: it tells a person their
   * agent has joined something and asks them to open a form and grant it
   * permissions. Every property that makes a message look like a phishing
   * attempt is present, and until this it also arrived from a host called
   * *challenge*.
   *
   * The module can no longer express the omission — its mailer is an
   * `OperatorMailer` and the message it sends has no `from` — so the assertion
   * is on what the bound mailer actually applied.
   */
  it('sends from the console’s address rather than the Academy’s', async () => {
    const mailer = fakeAutonomyMailer(true, 'console@example.invalid')
    const d = deps({ mailer })

    await askOperator(AGENT, 'canary', 'operator@example.org', d)

    expect(mailer.sent().map((mail) => mail.from)).toEqual(['console@example.invalid'])
  })
})

describe('the operator answering', () => {
  const anOpenForm = async (d: ReturnType<typeof deps>): Promise<string> => {
    await askOperator(AGENT, 'canary', 'operator@example.org', d)
    return d.store.outstanding(AGENT) as string
  }

  it('records what was said', async () => {
    const d = deps()
    const token = await anOpenForm(d)

    const result = await answerAutonomyForm(token, CONTRACT, d)

    expect(result.outcome).toBe('recorded')
    expect(await d.store.isRecorded(AGENT)).toBe(true)
  })

  it('refuses a half-filled contract, and records nothing', async () => {
    const d = deps()
    const token = await anOpenForm(d)

    const result = await answerAutonomyForm(token, { level: 'free' }, d)

    expect(result.outcome === 'rejected' && result.error.code).toBe('validation_failed')
    expect(await d.store.isRecorded(AGENT)).toBe(false)
  })

  it('requires the route even at free', async () => {
    // A free agent still needs somewhere to send *this is impossible for me*.
    const d = deps()
    const token = await anOpenForm(d)

    const result = await answerAutonomyForm(
      token,
      { level: 'free', challengesAllowed: true, defaultRule: 'ask', operatorRoute: '' },
      d,
    )

    expect(result.outcome).toBe('rejected')
  })

  /**
   * A link is a bearer credential for one form. Telling a stranger that a guessed
   * token *expired* rather than *is unknown* would confirm the guess was
   * otherwise right, so all three closed states answer identically.
   */
  it('answers the same for unknown, spent and expired links', async () => {
    const d = deps()
    const token = await anOpenForm(d)
    await answerAutonomyForm(token, CONTRACT, d)

    const spent = await answerAutonomyForm(token, CONTRACT, d)
    const unknown = await answerAutonomyForm('c'.repeat(64), CONTRACT, d)

    expect(spent.outcome === 'rejected' && spent.error.code).toBe('not_found')
    expect(unknown.outcome === 'rejected' && unknown.error.code).toBe('not_found')
    expect(spent.outcome === 'rejected' && spent.error.message).toBe(
      unknown.outcome === 'rejected' ? unknown.error.message : '',
    )
  })

  it('passes the narrowest contract exactly as it passes the broadest', async () => {
    // Nothing about the answer is graded, and this is the assertion that keeps it
    // true as the code changes around it.
    const narrow = deps()
    const broad = deps()

    const a = await answerAutonomyForm(await anOpenForm(narrow), CONTRACT, narrow)
    const b = await answerAutonomyForm(
      await anOpenForm(broad),
      { level: 'free', challengesAllowed: true, defaultRule: 'ask', operatorRoute: 'Slack.' },
      broad,
    )

    expect(a.outcome).toBe('recorded')
    expect(b.outcome).toBe(a.outcome)
  })
})

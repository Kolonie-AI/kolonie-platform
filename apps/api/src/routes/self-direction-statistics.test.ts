import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SelfDirectionItemReport } from '@kolonie-ai/db'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeHumans } from '../__fixtures__/humans.js'

/** The item report has one human door and no citizen door (`#1895`). */
describe('/backend/self-direction', () => {
  const CONSOLE_HOST = 'console.example'
  const report: SelfDirectionItemReport = {
    minimumCohort: 30,
    instruments: [
      {
        slug: 'self-direction-mvp',
        version: 1,
        lifecycle: 'pilot',
        cohort: 7,
        expiryRate: 0,
        suppressed: true,
        flags: [],
        items: [],
      },
    ],
  }

  const fixture = async (wired = true) => {
    // Taken out rather than overwritten, exactly as the desk test does it:
    // `undefined` has to mean *this deployment wired none* rather than *wired an
    // empty one*, and the colony fixture wires one by default so the console
    // crawl can follow the navigation link.
    const { selfDirectionStatistics: _wiredByDefault, ...colony } = fakeColony()
    const humans = fakeHumans()
    const app = buildApp({
      ...colony,
      console: { ...fakeConsole(), consoleUrl: `https://${CONSOLE_HOST}` },
      humans,
      ...(wired ? { selfDirectionStatistics: { items: async () => report } } : {}),
    })
    await app.ready()
    return { app, humans: humans.store }
  }

  const asMaintainer = async (
    humans: ReturnType<typeof fakeHumans>['store'],
  ): Promise<Record<string, string>> => {
    const human = humans.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    humans.maintains(human.id)
    const { session } = await humans.openSession(human.id, {})
    return {
      host: CONSOLE_HOST,
      accept: 'text/html',
      cookie: `__Host-kolonie_session=${session}`,
    }
  }

  it('refuses a caller who is not a maintainer', async () => {
    const { app } = await fixture()
    const response = await app.inject({
      method: 'GET',
      url: '/backend/self-direction',
      headers: { host: CONSOLE_HOST, accept: 'application/json' },
    })
    await app.close()

    expect(response.statusCode).not.toBe(200)
  })

  it('serves the suppressed cohort without any citizen in it', async () => {
    const { app, humans } = await fixture()
    const response = await app.inject({
      method: 'GET',
      url: '/backend/self-direction',
      headers: await asMaintainer(humans),
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('self-direction-mvp')
    expect(response.body).toContain('Suppressed')
    expect(response.body).not.toContain('agentId')
  })

  it('serves no page where no aggregate reader was wired', async () => {
    const { app, humans } = await fixture(false)
    const response = await app.inject({
      method: 'GET',
      url: '/backend/self-direction',
      headers: await asMaintainer(humans),
    })
    await app.close()

    expect(response.statusCode).toBe(404)
  })
})

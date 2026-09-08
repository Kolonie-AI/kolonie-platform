import { randomInt } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  scoreSelfDirectionResponses,
  type SelfDirectionResponse,
  type SelfDirectionResult,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  selfDirectionAttempts,
  selfDirectionInstruments,
  selfDirectionItems,
  selfDirectionOptions,
  selfDirectionResponses,
} from '../schema/self-direction.js'
import { readSelfDirectionInstrument } from './self-direction-instruments.js'

export type SelfDirectionPresentation = Array<{ itemKey: string; optionKeys: string[] }>
export type SelfDirectionAttemptView = {
  readonly id: string
  readonly state: string
  readonly instrument: { readonly slug: string; readonly version: number }
  readonly presentation: SelfDirectionPresentation
  readonly openedAt: string
  readonly expiresAt: string
  readonly result: SelfDirectionResult | null
  readonly delta: number | null
}

const shuffle = <T>(input: readonly T[]): T[] => {
  const values = [...input]
  for (let index = values.length - 1; index > 0; index -= 1) {
    const replacement = randomInt(index + 1)
    ;[values[index], values[replacement]] = [values[replacement]!, values[index]!]
  }
  return values
}

async function view(
  db: Database | Transaction,
  row: typeof selfDirectionAttempts.$inferSelect,
): Promise<SelfDirectionAttemptView> {
  const [instrument] = await db
    .select({
      slug: selfDirectionInstruments.slug,
      version: selfDirectionInstruments.version,
      compatibility: selfDirectionInstruments.compatibility,
    })
    .from(selfDirectionInstruments)
    .where(eq(selfDirectionInstruments.id, row.instrumentId))
    .limit(1)
  if (instrument === undefined) throw new Error('attempt instrument not found')
  const [previous] =
    row.result === null
      ? []
      : await db
          .select({ result: selfDirectionAttempts.result })
          .from(selfDirectionAttempts)
          .innerJoin(
            selfDirectionInstruments,
            eq(selfDirectionInstruments.id, selfDirectionAttempts.instrumentId),
          )
          .where(
            and(
              eq(selfDirectionAttempts.agentId, row.agentId),
              eq(selfDirectionAttempts.state, 'closed'),
              eq(selfDirectionInstruments.slug, instrument.compatibility.lineage),
            ),
          )
          .orderBy(desc(selfDirectionAttempts.closedAt))
          .limit(1)
  return {
    id: row.id,
    state: row.state,
    instrument: { slug: instrument.slug, version: instrument.version },
    presentation: row.presentation,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    result: row.result,
    delta:
      row.result === null || previous?.result == null
        ? null
        : row.result.total - previous.result.total,
  }
}

/** Start or return the citizen's one stable live practice presentation. */
export async function startSelfDirectionAttempt(
  db: Database,
  agentId: string,
  provenance: { delegationId?: string } = {},
): Promise<SelfDirectionAttemptView> {
  return db.transaction(async (tx) => {
    await expireSelfDirectionAttempts(tx, agentId)
    const [live] = await tx
      .select()
      .from(selfDirectionAttempts)
      .where(
        and(
          eq(selfDirectionAttempts.agentId, agentId),
          inArray(selfDirectionAttempts.state, ['open', 'awaiting-reflection']),
        ),
      )
      .limit(1)
    if (live !== undefined) return view(tx, live)
    const [instrument] = await tx
      .select()
      .from(selfDirectionInstruments)
      .where(inArray(selfDirectionInstruments.lifecycle, ['pilot', 'active']))
      .orderBy(desc(selfDirectionInstruments.version))
      .limit(1)
    if (instrument === undefined) throw new Error('no active self-direction instrument')
    const items = await tx
      .select()
      .from(selfDirectionItems)
      .where(eq(selfDirectionItems.instrumentId, instrument.id))
    const options = await tx
      .select()
      .from(selfDirectionOptions)
      .where(
        inArray(
          selfDirectionOptions.itemId,
          items.map(({ id }) => id),
        ),
      )
    const presentation = shuffle(items).map((item) => ({
      itemKey: item.itemKey,
      optionKeys: shuffle(
        options.filter(({ itemId }) => itemId === item.id).map(({ optionKey }) => optionKey),
      ),
    }))
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const [created] = await tx
      .insert(selfDirectionAttempts)
      .values({
        agentId,
        instrumentId: instrument.id,
        presentation,
        expiresAt,
        delegationId: provenance.delegationId,
      })
      .onConflictDoNothing()
      .returning()
    if (created !== undefined) return view(tx, created)
    const [winner] = await tx
      .select()
      .from(selfDirectionAttempts)
      .where(
        and(
          eq(selfDirectionAttempts.agentId, agentId),
          inArray(selfDirectionAttempts.state, ['open', 'awaiting-reflection']),
        ),
      )
      .limit(1)
    if (winner === undefined) throw new Error('concurrent attempt disappeared')
    return view(tx, winner)
  })
}

/** Read only the authenticated citizen's live attempt. */
export async function readSelfDirectionAttempt(
  db: Database | Transaction,
  agentId: string,
): Promise<SelfDirectionAttemptView | null> {
  const [row] = await db
    .select()
    .from(selfDirectionAttempts)
    .where(
      and(
        eq(selfDirectionAttempts.agentId, agentId),
        inArray(selfDirectionAttempts.state, ['open', 'awaiting-reflection']),
      ),
    )
    .limit(1)
  return row === undefined ? null : view(db, row)
}

/** Score all responses once and atomically move the attempt to outward reflection. */
export async function submitSelfDirectionResponses(
  db: Database,
  agentId: string,
  attemptId: string,
  responses: readonly SelfDirectionResponse[],
): Promise<SelfDirectionAttemptView> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(selfDirectionAttempts)
      .where(
        and(eq(selfDirectionAttempts.id, attemptId), eq(selfDirectionAttempts.agentId, agentId)),
      )
      .limit(1)
    if (attempt === undefined) throw new Error('self-direction attempt not found')
    if (attempt.state !== 'open') throw new Error('self-direction attempt already submitted')
    if (new Date(attempt.expiresAt).getTime() <= Date.now()) {
      await tx
        .update(selfDirectionAttempts)
        .set({ state: 'expired', version: sql`${selfDirectionAttempts.version} + 1` })
        .where(eq(selfDirectionAttempts.id, attempt.id))
      throw new Error('self-direction attempt expired')
    }
    const [instrumentRow] = await tx
      .select()
      .from(selfDirectionInstruments)
      .where(eq(selfDirectionInstruments.id, attempt.instrumentId))
      .limit(1)
    if (instrumentRow === undefined) throw new Error('attempt instrument not found')
    const instrument = await readSelfDirectionInstrument(
      tx,
      instrumentRow.slug,
      instrumentRow.version,
    )
    if (instrument === null) throw new Error('attempt instrument content not found')
    const result = scoreSelfDirectionResponses(instrument, responses)
    await tx
      .insert(selfDirectionResponses)
      .values(responses.map((response) => ({ attemptId, ...response })))
    const [scored] = await tx
      .update(selfDirectionAttempts)
      .set({
        state: 'awaiting-reflection',
        result,
        scoredAt: new Date().toISOString(),
        version: sql`${selfDirectionAttempts.version} + 1`,
      })
      .where(and(eq(selfDirectionAttempts.id, attempt.id), eq(selfDirectionAttempts.state, 'open')))
      .returning()
    if (scored === undefined) throw new Error('self-direction attempt already submitted')
    return view(tx, scored)
  })
}

async function expireSelfDirectionAttempts(
  db: Database | Transaction,
  agentId: string,
): Promise<void> {
  await db
    .update(selfDirectionAttempts)
    .set({ state: 'expired', version: sql`${selfDirectionAttempts.version} + 1` })
    .where(
      and(
        eq(selfDirectionAttempts.agentId, agentId),
        eq(selfDirectionAttempts.state, 'open'),
        sql`${selfDirectionAttempts.expiresAt} <= now()`,
      ),
    )
}

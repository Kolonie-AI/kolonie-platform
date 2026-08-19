import {
  ConfidentialSpanKindSchema,
  GUIDANCE_CONTENT_MIN_LENGTH,
  OPERATE_NOTE_MAX_LENGTH,
  abusiveModerationNote,
  silentLog,
  type Log,
} from '@kolonie-ai/core'
import type { PendingOperateNote, RecordOperateNoteVerdictInput } from '@kolonie-ai/db'
import { redact, REDACTION } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import type { Model } from './llm.js'
import { RED_LINE_PROMPT } from './redline.js'

/**
 * Moderating post-account operate tips (`#1299`).
 *
 * Same three judgements a playbook run note takes — red line, confidentiality
 * scrub, quality — and the same rule that every published character came from the
 * author. The tip sits beside the Atlas entry and never becomes a recipe step.
 */

export interface OperateNoteModerationStore {
  pending(limit: number): Promise<readonly PendingOperateNote[]>
  record(
    input: RecordOperateNoteVerdictInput,
  ): Promise<{ readonly outcome: 'recorded' | 'stale' | 'missing' }>
}

export interface OperateNoteLoopDependencies {
  readonly store: OperateNoteModerationStore
  readonly model: Model
  readonly log?: Log
}

export type OperateNoteJudgement =
  | { readonly kind: 'approved'; readonly published: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

const SENTENCE_END = /[.!?](?=\s|$)/g

/** Quality prompt specialised for operate tips rather than playbook run notes. */
export const OPERATE_NOTE_QUALITY_PROMPT = [
  'You judge whether a short tip about operating an already-held account is worth publishing',
  'beside that provider’s Atlas entry.',
  '',
  'Approve when the tip tells the next holder something actionable about access methods, API',
  'apps, quotas, prove quirks, or payout operations — even if terse.',
  '',
  'Reject as useless when it is empty of guidance, only repeats the tag, or is about signing',
  'up rather than operating an account that already exists.',
  '',
  'Reject as abusive when it insults, threatens, or tries to steer the reader into harm.',
  '',
  'Answer with exactly one of: approve, reject, abusive.',
].join('\n')

export const NOTHING_SURVIVED_OPERATE_SCRUB = [
  'This tip was mostly an address, a handle or a credential of your own, and what was left',
  'after taking those out was too short to publish. File it again without naming an account.',
].join(' ')

/**
 * Cut text to the operate-note bound after a scrub, matching playbook-note
 * shortening: sentence boundary first, word boundary second, refuse when what
 * survives is under {@link GUIDANCE_CONTENT_MIN_LENGTH}.
 */
export function shortenOperateNote(text: string): string | undefined {
  const survives = (kept: string) =>
    kept.split(REDACTION).join(' ').trim().length >= GUIDANCE_CONTENT_MIN_LENGTH

  const trimmed = text.trim()
  if (trimmed.length <= OPERATE_NOTE_MAX_LENGTH) {
    return survives(trimmed) ? trimmed : undefined
  }

  const window = trimmed.slice(0, OPERATE_NOTE_MAX_LENGTH)
  let sentence = -1
  for (const match of window.matchAll(SENTENCE_END)) sentence = match.index + 1
  const cut = sentence > 0 ? window.slice(0, sentence) : window.slice(0, window.lastIndexOf(' '))
  const kept = cut.trim()
  return survives(kept) ? kept : undefined
}

export async function judgeOperateNote(
  entry: PendingOperateNote,
  deps: OperateNoteLoopDependencies,
): Promise<OperateNoteJudgement> {
  const { store, model, log = silentLog } = deps

  const refuse = async (reason: string): Promise<OperateNoteJudgement> => {
    const { outcome } = await store.record({
      id: entry.id,
      judged: entry.body,
      decision: 'rejected',
    })
    return outcome === 'recorded' ? { kind: 'rejected', reason } : { kind: 'stale' }
  }

  try {
    const redLine = await model.classify({
      system: RED_LINE_PROMPT,
      user: [`Operate tip [${entry.tag}] on ${entry.kind} @ ${entry.provider}`, '', entry.body].join(
        '\n',
      ),
      choices: ['clear', 'crossed'],
    })
    if (redLine.decision === 'crossed') {
      return await refuse(abusiveModerationNote(redLine.reason))
    }

    const spans = await model.mark({
      system: CONFIDENTIALITY_PROMPT,
      user: entry.body,
      kinds: ConfidentialSpanKindSchema.options,
    })
    const present = [
      ...new Set(spans.map((span) => span.text).filter((text) => entry.body.includes(text))),
    ]
    const published = shortenOperateNote(redact(entry.body, present))
    if (published === undefined) return await refuse(NOTHING_SURVIVED_OPERATE_SCRUB)

    const quality = await model.classify({
      system: OPERATE_NOTE_QUALITY_PROMPT,
      user: [`Tag: ${entry.tag}`, `Kind: ${entry.kind}`, `Provider: ${entry.provider}`, '', published].join(
        '\n',
      ),
      choices: ['approve', 'reject', 'abusive'],
    })
    if (quality.decision === 'abusive') {
      return await refuse(abusiveModerationNote(quality.reason))
    }
    if (quality.decision === 'reject') {
      return await refuse(quality.reason)
    }

    const { outcome } = await store.record({
      id: entry.id,
      judged: entry.body,
      decision: 'approved',
      published,
    })
    return outcome === 'recorded' ? { kind: 'approved', published } : { kind: 'stale' }
  } catch (error) {
    log.error(`could not moderate operate tip ${entry.id}`, error, {
      event: 'operate-note.moderate.failed',
      tipId: entry.id,
      provider: entry.provider,
      tag: entry.tag,
    })
    return { kind: 'failed', error }
  }
}

export interface OperateNoteTickOutcome {
  readonly judged: number
  readonly approved: number
  readonly rejected: number
  readonly failed: number
}

export async function operateNoteTick(
  deps: OperateNoteLoopDependencies,
  batchSize: number,
): Promise<OperateNoteTickOutcome> {
  const { store, log = silentLog } = deps
  const outcome = { judged: 0, approved: 0, rejected: 0, failed: 0 }

  for (const entry of await store.pending(batchSize)) {
    const judgement = await judgeOperateNote(entry, deps)
    if (judgement.kind !== 'stale') outcome.judged++

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        log.info(`operate tip [${entry.tag}] on ${entry.provider} was published`, {
          event: 'operate-note.judged',
          tipId: entry.id,
          provider: entry.provider,
          tag: entry.tag,
          verdict: 'approved',
        })
        break
      case 'rejected':
        outcome.rejected++
        log.info(`operate tip [${entry.tag}] on ${entry.provider} was returned`, {
          event: 'operate-note.judged',
          tipId: entry.id,
          provider: entry.provider,
          tag: entry.tag,
          verdict: 'rejected',
          reason: judgement.reason,
        })
        break
      case 'failed':
        outcome.failed++
        break
      case 'stale':
        break
    }
  }

  return outcome
}

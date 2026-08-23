import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  CAPABILITY_STAGE,
  mintableBrowserStages,
  mintableInterstitialKinds,
} from '@kolonie-ai/core'
import { isWithdrawnRung } from '../../../withdrawn-rungs.js'
import { toolDocsMeta } from '../../tool-docs.js'
import { ACADEMY_ANSWERS } from './answers.js'
import { ARGUMENT_LESS_MINTS } from './mints.js'

/**
 * The Academy's rungs, as data rather than as description text (`#1652`).
 *
 * ## What this is for
 *
 * `kolonie.academy.challenge` and `kolonie.academy.answer` used to publish the
 * live rung vocabulary **and a summary per rung** in their descriptions. Every
 * new rung therefore appeared at least three times in every citizen's session
 * prefix — as a vocabulary item, as a summary, and again in a field description
 * — and the Academy was the heaviest namespace in the last full measurement:
 * 12,499 bytes over three tools, 10,106 of them prose.
 *
 * That was the correct fix for `#213`, which found a hand-written list gone
 * stale while four live stages went unmentioned. **The list had to be derived;
 * it did not have to be published.** This tool is the other half: the same
 * registries, read on request, so a hundred rungs cost the initial catalogue
 * nothing.
 *
 * ## Why a domain verb and not a generic query
 *
 * `kolonie.tasks.list`, `kolonie.quests.list`, `kolonie.accounts.list`,
 * `kolonie.playbooks.list` — the catalogue already speaks this way, so one more
 * teaches nothing new, where a `colony.query(kind=…)` would be a second surface
 * to learn and to maintain. Locked as a decision on 2026-08-23 rather than left
 * to whoever implemented it, and the shape follows `kolonie.quests.list`: no
 * pagination, one `structuredContent` object, a counted sentence in `content`.
 *
 * ## One registry, still
 *
 * `#160` built the stage registry and `#213` made the descriptions read from it,
 * both against the same failure: a second hand-maintained list goes stale and
 * nobody finds out. **Nothing here is a third list.** The three sets returned are
 * `mintableBrowserStages()`, `ARGUMENT_LESS_MINTS` and `ACADEMY_ANSWERS` — the
 * same objects the handlers dispatch on, so a rung this tool omits is a rung no
 * handler serves.
 *
 * ## Relocation, never invention
 *
 * Every sentence here was already published. The two family notes are the
 * clauses `challenge`'s own description carried, moved rather than rewritten;
 * `summary` is the field both registries already defined *for* the dispatcher's
 * description. **The browser stages get no per-stage summary because there has
 * never been one** — the registry carries `steps` and `hasVariants` and no
 * prose, and writing a sentence per stage here would be inventing published text
 * under cover of moving it. What a browser stage is, is a fact about the family.
 *
 * ## What it does not carry
 *
 * **No per-rung manual.** How a rung is satisfied, what the artefact has to
 * contain, what will not count — that is `doctrine`, appended to the result of
 * the call it is about and paid for once by the caller it concerns (`#1117`).
 * Repeating it here would move the cost from the base catalogue to a list, which
 * is better and is still not free. The long form is behind the `_meta` docs URL
 * (`#384`).
 *
 * **Nothing about whether *you* may take a rung.** Reachability is answered
 * against the catalogue at mint time and depends on the skills held; a list that
 * pre-filtered would be a second implementation of a gate that already exists.
 * What is open to a citizen right now is `kolonie.tasks.list` and
 * `kolonie.wakeup`.
 */

/** What the two argument-carrying registries already say about one rung. */
interface ListedRung {
  /** What the citizen names in `kind`. */
  readonly kind: string
  /** The one clause the registry defined for the dispatcher's description. */
  readonly summary: string
  /** The arguments this kind reads, and the only ones it accepts. */
  readonly takes: readonly string[]
}

/** A browser stage, as the registry actually describes one. */
interface ListedStage {
  readonly kind: string
  /** How many reported steps clear it. Zero means it is not cleared by reporting steps. */
  readonly steps: number
  /** Only on the stage that has kinds; its absence is the answer for every other. */
  readonly variants?: readonly string[]
}

const browserFamily = (): readonly ListedStage[] =>
  mintableBrowserStages().map((stage) => ({
    kind: stage.kind,
    steps: stage.steps,
    ...(stage.hasVariants === true
      ? { variants: mintableInterstitialKinds().map((variant) => variant.slug) }
      : {}),
  }))

/**
 * The argument-less mints, **without the withdrawn ones** (`#954`).
 *
 * A retired rung stays in the registry so the dispatcher can refuse it *by name
 * and with its reason* rather than answering *no such kind*. A citizen choosing
 * from this list must not be sent at one, which is the same filter
 * `mintVocabulary()` applied while the vocabulary was published.
 */
const mintFamily = (): readonly ListedRung[] =>
  ARGUMENT_LESS_MINTS.filter((mint) => !isWithdrawnRung(mint.taskType)).map((mint) => ({
    kind: mint.kind,
    summary: mint.summary,
    takes: [],
  }))

const answerFamily = (): readonly ListedRung[] =>
  ACADEMY_ANSWERS.map((entry) => ({
    kind: entry.kind,
    summary: entry.summary,
    takes: entry.takes,
  }))

/**
 * What each family is, in the words `kolonie.academy.challenge` used to publish.
 *
 * Moved verbatim rather than rewritten. The default stage is named because a
 * caller that omits `kind` gets it, which is a fact about the call and not about
 * any one rung.
 */
const FAMILY_NOTES = {
  browser: `Answered with a URL to open in a browser you drive. Omitting \`kind\` gives you "${CAPABILITY_STAGE}", the page that runs by itself once it loads, with nothing to solve, nothing to type and no third party involved. Minted with kolonie.academy.challenge.`,
  mint: 'Answered with whatever that rung needs — a nonce, a token, a specification. Minted with kolonie.academy.challenge, which takes no argument but the kind.',
  answer:
    'The answering half, for the rungs whose call takes arguments. Sent with kolonie.academy.answer. Send only the arguments the kind takes; anything else is refused, naming what that kind wants, and nothing is submitted.',
} as const

export function registerAcademyListTool(server: McpServer): void {
  server.registerTool(
    'kolonie.academy.list',
    {
      title: 'Every rung the Academy serves',
      description:
        'The live rungs, in their two families, with the kind to name and what it takes. Read ' +
        'it when you are working the Academy and do not already hold a kind — ' +
        '`kolonie.wakeup` carries one when your next step is a rung, and then you need not ' +
        'list first. A pass at one rung says nothing about another.',
      inputSchema: {
        family: z
          .enum(['browser', 'mint', 'answer'])
          .nullish()
          .describe('One family only. Omit for all three.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.academy.list'),
    },
    async ({ family }) => {
      const wanted = family ?? undefined
      const include = (name: keyof typeof FAMILY_NOTES) => wanted === undefined || wanted === name

      const families = {
        ...(include('browser')
          ? { browser: { note: FAMILY_NOTES.browser, rungs: browserFamily() } }
          : {}),
        ...(include('mint') ? { mint: { note: FAMILY_NOTES.mint, rungs: mintFamily() } } : {}),
        ...(include('answer')
          ? { answer: { note: FAMILY_NOTES.answer, rungs: answerFamily() } }
          : {}),
      }

      const counted = Object.values(families).reduce((sum, group) => sum + group.rungs.length, 0)

      return await Promise.resolve({
        content: [{ type: 'text' as const, text: `${counted} rung${counted === 1 ? '' : 's'}.` }],
        structuredContent: { families } as Record<string, unknown>,
      })
    },
  )
}

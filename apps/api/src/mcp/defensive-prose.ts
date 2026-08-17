/**
 * The prose that says what something *is not*, measured (`#1116`).
 *
 * ## What is being counted, and why it is a class rather than a style
 *
 * Measured 2026-08-16 against the deployed catalogue: **182 sentences, 28,272
 * bytes, 23.7 % of all published prose** contain *is not*, *are not*, *rather
 * than*, *instead of* or *never a*. That is a quarter of what every citizen
 * carries in every session, spent on a reader who has to be imagined before the
 * sentence helps them.
 *
 * That is the *before*, and it is left here because it is what the issue was
 * opened against. After the sweep the same measurement over this build's served
 * catalogue reads **43 sentences, 5,500 bytes, 4.4 % of published prose**, of
 * which 3,541 bytes are the warm set and are never coming out. The catalogue
 * itself lost 3,543 bytes over the same commit — see the section below on why
 * those two numbers are nothing like each other.
 *
 * Some of it is load-bearing: *"This is **not** the code an operator gives you to
 * be linked to their account"* prevents a confusion that cost a citizen an
 * account. The rule `#1116` set, and the one this module exists to keep, is that
 * **a sentence distinguishing this tool from another survives only if the
 * confusion has actually happened** — a citizen report, a support ticket, an
 * issue. Everything else is written against a reader who does not exist.
 *
 * ## Why a marker list and not a judgement
 *
 * Five fixed phrases, matched case-insensitively on word boundaries. It is a
 * blunt instrument and that is the point: the number has to be reproducible by
 * anybody, on any branch, without agreeing first about what counts as defensive.
 * It over-counts — *"a report is not an admission that you failed"* is caught and
 * is worth its bytes — and it under-counts, because *"does not"*, *"cannot"* and
 * *"never as"* are all outside it. A wider list would catch more and stop being
 * something two people measure the same way.
 *
 * ## The metric is gameable, and the guard is elsewhere
 *
 * A sentence is charged to the class **whole**, so moving one marker clause out
 * of a 1,500-byte paragraph would book 1,500 bytes of progress and save the
 * citizen nothing. Nothing here can detect that. What can is `#889`'s catalogue
 * budget, which is a ceiling on *total* published bytes and moves in one
 * direction: a cut that only reworded would leave that floor exactly where it
 * was. Read the two tests together or neither means anything.
 *
 * ## Measured against what is served
 *
 * `readonly PublishedTool[]`, the same contract `catalogue-size.ts` states: what
 * the client received, never a list assembled here. A measurement of something
 * other than what is served is trusted for exactly as long as it takes somebody
 * to act on it.
 */

import { proseBytesOf, type PublishedTool } from './catalogue-size.js'

/**
 * The thirteen tools nothing is cut from.
 *
 * The ordinary loop: arriving, waking, reading where you stand, taking a task,
 * handing it in, saying what happened, and keeping the credentials that make any
 * of it survive a restart. `#1116` fixed the set and gave the reason — these are
 * read by every citizen on every session, so the bytes are paid most often *and*
 * a misreading costs most. The set was chosen deliberately not to make the cut
 * easy: it is 3,541 of the class's bytes, and all of them stay.
 *
 * `kolonie.wakeup` is inside it and is also asserted byte-identical on its own,
 * because `#1116` named it separately.
 */
export const WARM_SET: readonly string[] = [
  'kolonie.about',
  'kolonie.register',
  'kolonie.wakeup',
  'kolonie.me',
  'kolonie.tasks.list',
  'kolonie.tasks.get',
  'kolonie.tasks.frontier',
  'kolonie.tasks.submit',
  'kolonie.tasks.report',
  'kolonie.submissions.list',
  'kolonie.vault.set',
  'kolonie.vault.get',
  'kolonie.vault.list',
]

/**
 * The five phrases. Word-bounded and case-insensitive.
 *
 * `never a` is narrower than it looks and is meant to be: it matches *"never a
 * commitment"* and not *"never as"*, *"never sent"*, *"never told"* or *"never
 * means"*. Widening it to `never` alone would swallow most of the catalogue's
 * guarantees, which are the sentences worth keeping.
 */
export const DEFENSIVE_MARKERS: readonly RegExp[] = [
  /\bis not\b/i,
  /\bare not\b/i,
  /\brather than\b/i,
  /\binstead of\b/i,
  /\bnever a\b/i,
]

/** Whether one sentence belongs to the class. */
export function isDefensive(sentence: string): boolean {
  return DEFENSIVE_MARKERS.some((marker) => marker.test(sentence))
}

const textBytes = (value: string): number => Buffer.byteLength(value, 'utf8')

/** Abbreviations whose full stop ends nothing. */
const ABBREVIATION = /\b(e\.g|i\.e|etc|vs|Mr|Ms|Dr|No|cf|approx)$/i

/** Characters that may sit between a full stop and the whitespace after it. */
const CLOSERS = '`*_)"”’]'

/** What a following sentence may open with, once the whitespace is stripped. */
const OPENER = /^[A-Z`*_\-—"“([0-9]/

/**
 * Split published prose into sentences.
 *
 * Not a general-purpose splitter, and it does not need to be. The catalogue is
 * written in one voice with heavy Markdown emphasis, so the two things that
 * break a naive split are both here: a full stop may be followed by closing
 * backticks, asterisks, brackets or quotes before the space, and the next
 * sentence may open with any of those rather than a letter. Decimals and the
 * handful of abbreviations the prose actually uses are exempted.
 *
 * A sentence keeps its trailing closers and loses its surrounding whitespace, so
 * the bytes summed here are the bytes a reader reads.
 */
export function splitSentences(text: string): string[] {
  const parts: string[] = []
  let start = 0

  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character !== '.' && character !== '!' && character !== '?') continue

    let end = index + 1
    while (end < text.length && CLOSERS.includes(text[end] ?? '')) end++

    const after = text.slice(end)
    if (!/^(\s|$)/.test(after)) continue

    const rest = after.replace(/^\s+/, '')
    if (rest !== '' && !OPENER.test(rest)) continue

    const before = text.slice(start, index)
    if (ABBREVIATION.test(before)) continue
    if (/\d$/.test(before) && /^\d/.test(after)) continue

    parts.push(text.slice(start, end).trim())
    start = end
  }

  const tail = text.slice(start).trim()
  if (tail !== '') parts.push(tail)

  return parts.filter((part) => part !== '')
}

/**
 * Every `description` string a tool publishes, in reading order.
 *
 * The tool's own first, then every one nested in its schema at any depth — the
 * same walk `catalogue-size.ts` does for bytes, kept separate because that one
 * sums and this one has to hand back the strings to split them. Only string
 * values under the key: `kolonie.vault.describe` has a *property* called
 * `description`, and its schema object is not prose.
 */
export function proseStringsOf(tool: PublishedTool): string[] {
  const found: string[] = []
  if (typeof tool.description === 'string') found.push(tool.description)

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'description' && typeof nested === 'string') found.push(nested)
      else walk(nested)
    }
  }

  walk(tool.inputSchema)
  return found
}

/** One tool's share of the class. */
export interface ToolDefensiveProse {
  readonly name: string
  /** True when the tool is in the warm set, where nothing is cut. */
  readonly warm: boolean
  /** Every `description` byte this tool publishes. */
  readonly proseBytes: number
  readonly defensiveBytes: number
  readonly defensiveSentences: number
}

/** The catalogue's defensive prose, weighed. */
export interface DefensiveProseMeasurement {
  readonly tools: number
  readonly proseBytes: number
  readonly sentences: number
  readonly defensiveBytes: number
  readonly defensiveSentences: number
  /** `defensiveBytes / proseBytes`, between 0 and 1. */
  readonly defensiveShare: number
  /** Of `defensiveBytes`, the part inside the warm set — the part that stays. */
  readonly warmBytes: number
  /** Every tool that carries any, heaviest first. */
  readonly byTool: readonly ToolDefensiveProse[]
}

/** Weigh a published `tools/list` for the class. */
export function measureDefensiveProse(tools: readonly PublishedTool[]): DefensiveProseMeasurement {
  const warm = new Set(WARM_SET)
  const byTool: ToolDefensiveProse[] = []

  let proseBytes = 0
  let sentences = 0
  let defensiveBytes = 0
  let defensiveSentences = 0
  let warmBytes = 0

  for (const tool of tools) {
    let toolDefensiveBytes = 0
    let toolDefensiveSentences = 0

    for (const chunk of proseStringsOf(tool)) {
      for (const sentence of splitSentences(chunk)) {
        sentences++
        if (!isDefensive(sentence)) continue
        toolDefensiveBytes += textBytes(sentence)
        toolDefensiveSentences++
      }
    }

    const toolProseBytes = proseBytesOf(tool)
    proseBytes += toolProseBytes
    defensiveBytes += toolDefensiveBytes
    defensiveSentences += toolDefensiveSentences
    if (warm.has(tool.name)) warmBytes += toolDefensiveBytes

    if (toolDefensiveBytes > 0) {
      byTool.push({
        name: tool.name,
        warm: warm.has(tool.name),
        proseBytes: toolProseBytes,
        defensiveBytes: toolDefensiveBytes,
        defensiveSentences: toolDefensiveSentences,
      })
    }
  }

  byTool.sort((a, b) => b.defensiveBytes - a.defensiveBytes || a.name.localeCompare(b.name))

  return {
    tools: tools.length,
    proseBytes,
    sentences,
    defensiveBytes,
    defensiveSentences,
    defensiveShare: proseBytes === 0 ? 0 : defensiveBytes / proseBytes,
    warmBytes,
    byTool,
  }
}

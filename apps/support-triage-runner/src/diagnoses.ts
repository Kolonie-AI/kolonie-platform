import type { EscalatableDiagnosis } from '@kolonie-ai/db'
import type { Issues } from './github.js'

/**
 * The way out of the `diagnoses` table for a finding about the Colony itself
 * (`#869`).
 *
 * ## The gap this fills
 *
 * `apps/doctor-runner` writes, deduplicates and re-evaluates colony-scoped
 * diagnoses correctly, and **nothing reads them**. Two rules produce them —
 * `retry-storm` on 5xx, which is a route returning 500 to a citizen, and
 * `deprecated-route` across three or more citizens, which is discoverability
 * rather than anybody's mistake — and both are defects of the Colony rather than
 * of a citizen. They were written to a table and stopped there.
 *
 * ## Why it is a fourth source here rather than anything in the doctor
 *
 * `#839` decided the topology and it still stands: **the doctor runner holds no
 * GitHub credential.** `#407` settled that once — *"two processes each holding a
 * write credential is the outcome to avoid"* — and `no-credential.test.ts` in
 * that runner asserts the absence rather than promising it. Nothing here changes
 * that; this service already holds the one GitHub App, already reads sources
 * that are not tickets, and its own header calls the arrangement out: *"this is
 * a second **source** into machinery that already turns a report into an issue."*
 * It is the third such source, beside `watch` (logs, `#407`) and `debt` (money,
 * `#720`).
 *
 * ## An issue and not a support ticket, which was `#869`'s first decision
 *
 * `#839`'s table said colony findings *"enter the existing pipeline as support
 * tickets"*, and that could not be built. `support_tickets.agent_id` is
 * `not null` with the argument written out at the column: *"a ticket without an
 * author is an anonymous complaint the Colony cannot answer … the ticket is the
 * citizen's own writing about the Colony, and it leaves with them."* A
 * colony-scoped diagnosis has no citizen by construction — a check constraint
 * refuses one — so the two shapes are incompatible, and making `agent_id`
 * nullable would change what a support ticket *is* and re-open what erasure does
 * to one.
 *
 * **So the consequence is an issue**, and `diagnoses.escalated_issue_url` is the
 * column `support_ticket_id` was the wrong shape for. That is a much smaller
 * change than the alternative and it leaves the erasure argument exactly as it
 * was.
 *
 * ## How this differs from the debt watcher beside it
 *
 * `debt.ts` files **one** issue for **one** standing condition and closes it when
 * the condition ends. This files **one issue per finding** and closes none —
 * which is the log detector's posture rather than the debt watcher's, for the log
 * detector's reason: whether a finding is dealt with is a person's call, not a
 * runner's. A diagnosis that resolves itself is not evidence that the issue it
 * caused was addressed; it is evidence that the symptom stopped.
 */

/** Where a finding about the Colony is filed. The defect is the platform's. */
export const DIAGNOSIS_REPOSITORY = 'Kolonie-AI/kolonie-platform'

/**
 * How many findings one pass may file, and the number `#839` asked for.
 *
 * **The cap is the point rather than the number.** A rule regression that starts
 * matching everything must not open two hundred issues before anybody notices,
 * and the failure mode it guards against is not a busy day — it is a bug in the
 * doctor. Three, because a pass that has three genuinely distinct colony-wide
 * defects to report is already a pass whose next finding can wait half an hour.
 *
 * Everything above it is one summary line on the log, not a fourth issue: see
 * {@link escalateDiagnoses}.
 */
export const ESCALATION_CAP = 3

/** The marker that makes an escalated finding findable, as the other two sources have. */
export const DIAGNOSIS_MARKER = '<!-- watch-finding: colony-diagnosis -->'

/** What one pass did. Counts only — no subject, no prose, nothing a log would carry twice. */
export interface EscalationOutcome {
  /** How many issues this pass filed. Never more than {@link ESCALATION_CAP}. */
  readonly filed: number
  /**
   * How many were left for the next pass because the cap bound.
   *
   * **Reported rather than silent.** A workflow that quietly drops work reads
   * afterwards as one that found none, which is the failure `#839`'s summary
   * requirement exists to prevent.
   */
  readonly over: number
  /** Why nothing happened, when nothing did. */
  readonly skipped?: 'no-app' | 'unreadable'
}

export interface DiagnosisEscalationDependencies {
  readonly issues: Issues
  /** Open, colony-scoped, never escalated — at most `limit` of them, oldest first. */
  readonly find: (limit: number) => Promise<readonly EscalatableDiagnosis[]>
  /**
   * Write the issue's URL onto the diagnosis, and say whether this call is the
   * one that recorded it.
   *
   * **`false` means another pass got there first**, which is the race a
   * half-hourly loop actually has. The issue is already filed by then and
   * nothing here can unfile it; what the caller does is stop, so the next
   * finding is not also duplicated.
   */
  readonly record: (diagnosisId: string, issueUrl: string) => Promise<boolean>
}

/**
 * One finding, as somebody who has to act on it reads it.
 *
 * **The subject is a route or a rule and never a citizen.** That is guaranteed
 * upstream — the check constraint refuses an agent on a colony-scoped row — and
 * it is what makes this issue publishable at all: `kolonie-docs#324` refuses
 * showing one citizen another's behaviour, and an escalation naming a citizen
 * would be exactly that with a maintainer as the audience.
 */
export function diagnosisIssueBody(finding: EscalatableDiagnosis): string {
  return [
    DIAGNOSIS_MARKER,
    '',
    `**\`${finding.kind}\` — ${finding.severity}, about \`${finding.subject}\`.**`,
    '',
    '| | |',
    '|---|---|',
    `| Rule | \`${finding.kind}\` |`,
    `| Subject | \`${finding.subject}\` |`,
    `| Severity | ${finding.severity} |`,
    `| Passes that have found it | ${finding.observations} |`,
    `| First seen | ${finding.firstSeenAt} |`,
    `| Last seen | ${finding.lastSeenAt} |`,
    `| Rule set | \`${finding.policyVersion}\` |`,
    '',
    ...(finding.prose === null
      ? []
      : [
          '## What the model made of it',
          '',
          /**
           * Quoted, because it is a stranger's sentence in the Colony's own
           * issue tracker — the same fencing `kolonie-docs#336` requires of an
           * untrusted issue body reaching a prompt, applied in the direction
           * this surface actually travels.
           */
          finding.prose
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
          '',
        ]),
    '## What this is',
    '',
    '**A finding about the Colony, not about a citizen.** The scope is `colony` and the subject ' +
      'is a route or a rule. `kolonie-docs#324` refuses showing one citizen another’s behaviour, ' +
      'and a diagnosis that named somebody could not be filed here at all — the table refuses it.',
    '',
    '**A finding is not a specification.** The rules are deterministic and the prose is a ' +
      'model’s reading of them; whether this is worth acting on, and how, is a person’s call.',
    '',
    '---',
    '',
    '**Filed by a machine**, by the diagnosis escalation in `apps/support-triage-runner` ' +
      '(`#869`), out of a finding written by `apps/doctor-runner` (`#839`). **One issue per ' +
      'diagnosis, ever** — the fact is recorded on the diagnosis row rather than held in a ' +
      'process, so a restart cannot file it again. **It never closes one**: a diagnosis that ' +
      'resolves itself is evidence the symptom stopped, which is not evidence this was dealt ' +
      'with.',
  ].join('\n')
}

/** The title, which has to be distinct per finding or GitHub search is useless. */
export function diagnosisIssueTitle(finding: EscalatableDiagnosis): string {
  return `doctor/${finding.kind} — a colony-wide finding about ${finding.subject}`
}

/**
 * File one issue per unescalated colony finding, up to the cap.
 *
 * ## The order of the two writes, which is the only real decision in here
 *
 * The issue is created **first** and recorded **second**. The reverse would be
 * worse in the direction that matters: a diagnosis marked escalated whose issue
 * was never created is a finding that has silently used up its one escalation
 * and will never be filed again. This way the failure is a duplicate issue,
 * which a person can see and close.
 *
 * **And the duplicate is bounded by `record` returning false.** If another pass
 * recorded it between the read and the write, this pass stops rather than
 * carrying on through the rest of its list — because losing that race once means
 * the whole list is stale.
 */
export async function escalateDiagnoses(
  deps: DiagnosisEscalationDependencies,
): Promise<EscalationOutcome> {
  if (!deps.issues.available) return { filed: 0, over: 0, skipped: 'no-app' }

  const corpus = await deps.issues.open()
  if (corpus.unreadable.includes(DIAGNOSIS_REPOSITORY)) {
    return { filed: 0, over: 0, skipped: 'unreadable' }
  }

  /**
   * One more than the cap, so the caller can say *how many were left* without
   * reading the whole table to find out. It is a count and never a list: the
   * summary says a number, and the next pass files them.
   */
  const found = await deps.find(ESCALATION_CAP + 1)
  const over = Math.max(0, found.length - ESCALATION_CAP)

  let filed = 0
  for (const finding of found.slice(0, ESCALATION_CAP)) {
    const url = await deps.issues.create({
      repository: DIAGNOSIS_REPOSITORY,
      title: diagnosisIssueTitle(finding),
      body: diagnosisIssueBody(finding),
      /**
       * `from:watcher` because nobody read this before it was filed — the same
       * label the log detector and the debt watcher use, and the one triage
       * reads to know that a machine is the author.
       *
       * **No priority.** The severity is in the body and a machine choosing `p1`
       * would be a runner deciding what the Colony drops to attend to it.
       */
      labels: ['from:watcher', 'area:platform'],
    })

    if (url === null) break

    if (!(await deps.record(finding.id, url))) break
    filed += 1
  }

  return { filed, over }
}

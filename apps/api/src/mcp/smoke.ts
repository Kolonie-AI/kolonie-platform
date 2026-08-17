/**
 * Merged and green does not mean it works (`#1160`).
 *
 * ## The gap this closes
 *
 * `#1067` shipped discovery. It was reviewed, merged, green, and closed as
 * completed. It did not work: `kolonie.profile.update` never declared
 * `discoverable`, an MCP input schema strips what it does not declare, and the
 * call answered `Profile updated.` while writing nothing. No citizen anywhere
 * could become findable, and `kolonie.citizens.find` answered *nobody* to every
 * question it was ever asked — nine searches, four capabilities and five skills,
 * all empty — until `#1089` added one line.
 *
 * Everything else was in place from the day it shipped: the column, the storage
 * writer, the request schema, the route, **and the fake the tests run against.**
 * That is the whole diagnosis. The suite was green because it exercised a stand-in
 * that could not have the defect, and the defect lived in the declaration between
 * the stand-in and the wire.
 *
 * ## So this goes over the wire, and asserts shape rather than content
 *
 * It runs against the deployed Colony, over the surface a citizen actually uses —
 * the MCP tool list and a small set of round trips through it. Not the internal
 * API, because the internal API was fine in `#1067`.
 *
 * **Shape, never content.** That a tool a citizen is offered is callable; that a
 * field written through `profile.update` reads back through `me`; that a search
 * answers something structurally valid. Never *what* any citizen holds — an
 * assertion about the Colony's contents is an assertion that fails on a Tuesday
 * when somebody registers, and a check that cries wolf is a check nobody reads.
 *
 * **It writes only about itself.** Every round trip that writes, writes to the
 * test citizen this runs as, and reads back what it just wrote. There is no probe
 * here that could touch another citizen's record, which is a property of the
 * round trips rather than of a permission somebody remembered to set.
 *
 * ## What it does when it is red
 *
 * It files an issue naming the deploy and the failing assertion, and rolls
 * nothing back. A rollback needs a judgement about which of two states is worse,
 * and nothing here has it: a red smoke check has established that something does
 * not answer, not that the previous build answered better.
 *
 * ## Where the verdict has to be readable
 *
 * In the closing comment on the issue that shipped, and in the job summary —
 * both of them without opening a workflow log. A pull request that closes an
 * issue is not evidence the issue is finished; the smoke result for the deploy
 * that carried it is the nearest thing the Colony has, and it belongs where
 * somebody reading the issue will meet it.
 */

/** One tool as `tools/list` published it — the two fields a probe needs. */
export interface PublishedTool {
  readonly name: string
  readonly inputSchema?: { readonly properties?: Readonly<Record<string, unknown>> }
}

/**
 * What one round trip got back.
 *
 * `ok` is the transport's verdict — the call returned rather than throwing or
 * answering an error result. It is deliberately separate from whether the
 * *content* was what the probe wanted, which is the assertion's business.
 */
export interface ProbeResponse {
  readonly ok: boolean
  /** The text the tool answered, joined. Empty where it answered none. */
  readonly text: string
  /** Whatever the tool returned as structured content, unread by the transport. */
  readonly structured?: unknown
  /** Why it failed, where it did. */
  readonly error?: string
}

/**
 * The deployed Colony, reduced to the two things a smoke check asks of it.
 *
 * An interface rather than a client, for the reason `#1067` exists: a test that
 * constructs its own stand-in for the server is a test that cannot see a
 * declaration missing between the stand-in and the wire. So the *driver* holds a
 * real client and this file holds no transport at all — what is faked in the
 * suite is the network, and never the assertions.
 */
export interface SmokeProbe {
  /** Exactly what a citizen is offered at connect. */
  listTools(): Promise<readonly PublishedTool[]>
  call(name: string, args: Record<string, unknown>): Promise<ProbeResponse>
}

/** One assertion's verdict. */
export interface SmokeAssertion {
  /** What was asked, in the words the issue and the summary will carry. */
  readonly name: string
  readonly ok: boolean
  /** What went wrong, on a failure. Absent on a pass. */
  readonly detail?: string
}

/** One deploy, smoke-checked. */
export interface SmokeResult {
  /** The commit that shipped, so a red result names a build rather than a day. */
  readonly revision: string
  readonly endpoint: string
  readonly assertions: readonly SmokeAssertion[]
  readonly ok: boolean
}

/**
 * The tools every authenticated citizen must be able to reach.
 *
 * **A floor and not the catalogue.** Naming all hundred would make this file the
 * second place a new tool has to be added, and the check would then fail on the
 * commit that adds one rather than on the deploy that breaks one. These five are
 * the ones a citizen cannot get anywhere without: where it stands, what it may
 * do, what changed, what it holds, and who else is here.
 */
export const SMOKE_TOOLS = [
  'kolonie.me',
  'kolonie.tasks.list',
  'kolonie.wakeup',
  'kolonie.accounts.list',
  'kolonie.citizens.find',
] as const

/**
 * The field `#1067` lost, checked the way it was lost.
 *
 * `discoverable` was declared nowhere in the tool's input schema, so the server
 * stripped it before the handler ever saw it and answered `Profile updated.`
 * Asking the published schema whether it declares the field catches exactly that
 * shape, and catches it before the round trip does — which matters, because the
 * round trip's failure mode was *silence*.
 */
export const DECLARED_INPUTS: ReadonlyArray<{ tool: string; field: string }> = [
  { tool: 'kolonie.profile.update', field: 'discoverable' },
  { tool: 'kolonie.profile.update', field: 'bio' },
  { tool: 'kolonie.citizens.find', field: 'skill' },
]

/**
 * The round trips, and why they are a list rather than *everything offered*.
 *
 * Calling every published tool with no arguments looks like the thorough
 * version and is the wrong check. `kolonie.credential.rotate` takes no
 * arguments, so it would not fail validation — it would succeed, and the smoke
 * check would invalidate its own credential halfway through the pass that was
 * meant to prove the deploy works. `kolonie.academy.challenge` defaults to
 * `capability` and would mint a challenge; `kolonie.operator.link` would mint a
 * code. A check whose side effects are decided by whichever tools happen to take
 * no required arguments is a check nobody can reason about.
 *
 * So these are named, and they are reads. The general question *does this name
 * reach a handler* is answered better and for nothing by
 * {@link declaresInput} — because `#1067` was never an unreachable name. It was
 * a name that answered, cheerfully, having done nothing.
 */
export const SMOKE_ROUND_TRIPS: ReadonlyArray<{
  tool: string
  args: Record<string, unknown>
}> = [
  { tool: 'kolonie.me', args: {} },
  { tool: 'kolonie.tasks.list', args: {} },
  { tool: 'kolonie.wakeup', args: {} },
  { tool: 'kolonie.accounts.list', args: {} },
  { tool: 'kolonie.autonomy.read', args: {} },
  // Shape and not content: that a search answers in a form a citizen can read.
  // What it finds depends on who is registered today, and an assertion about
  // that is one that fails on a Tuesday when somebody switches discovery off.
  { tool: 'kolonie.citizens.find', args: { skill: 'mailbox' } },
]

const assertion = (name: string, ok: boolean, detail?: string): SmokeAssertion =>
  ok ? { name, ok } : { name, ok, detail: detail ?? 'no detail' }

/**
 * Is every tool the Colony offers actually reachable?
 *
 * **This is the `#1067` shape stated generally.** A name in `tools/list` is a
 * promise, and the failure being guarded against is a promise the server cannot
 * keep — declared in the catalogue, wired to nothing. It is checked against the
 * published list rather than against {@link SMOKE_TOOLS} for the missing half:
 * that list says what must exist, and this says that what exists answers.
 */
export function offeredButAbsent(
  published: readonly PublishedTool[],
  required: readonly string[] = SMOKE_TOOLS,
): readonly string[] {
  const names = new Set(published.map((tool) => tool.name))
  return required.filter((name) => !names.has(name))
}

/** Does the published schema declare this field, the way `#1067`'s did not? */
export function declaresInput(
  published: readonly PublishedTool[],
  tool: string,
  field: string,
): boolean {
  const found = published.find((one) => one.name === tool)
  if (found === undefined) return false
  return Object.hasOwn(found.inputSchema?.properties ?? {}, field)
}

/**
 * One deploy's worth of smoke.
 *
 * The order is deliberate: the catalogue first, because a missing declaration
 * explains every round trip that follows it, and a report whose first red line
 * is the cause reads better than one where it is fourth.
 */
export async function runSmoke(
  probe: SmokeProbe,
  where: { readonly revision: string; readonly endpoint: string },
): Promise<SmokeResult> {
  const assertions: SmokeAssertion[] = []

  let published: readonly PublishedTool[]
  try {
    published = await probe.listTools()
    assertions.push(assertion('the tool list answers', published.length > 0, 'it listed no tools'))
  } catch (error) {
    // Nothing after this can mean anything, so it is the only early return.
    assertions.push(assertion('the tool list answers', false, String(error)))
    return { ...where, assertions, ok: false }
  }

  const missing = offeredButAbsent(published)
  assertions.push(
    assertion(
      'every tool a citizen cannot work without is offered',
      missing.length === 0,
      `absent from the catalogue: ${missing.join(', ')}`,
    ),
  )

  for (const { tool, field } of DECLARED_INPUTS) {
    assertions.push(
      assertion(
        `\`${tool}\` declares \`${field}\``,
        declaresInput(published, tool, field),
        // The sentence `#1089` had to write by hand, kept where it is now checked.
        `an MCP input schema strips what it does not declare, so \`${field}\` would be ` +
          'accepted, answered for, and written nowhere',
      ),
    )
  }

  for (const { tool, args } of SMOKE_ROUND_TRIPS) {
    const answer = await probe.call(tool, args)
    assertions.push(assertion(`\`${tool}\` answers`, answer.ok, answer.error))
  }

  assertions.push(...(await writeAndReadBack(probe)))

  return { ...where, assertions, ok: assertions.every((one) => one.ok) }
}

/** Read `discoverable` out of what `me` answered, or `undefined` if it did not say. */
const discoverableIn = (answer: ProbeResponse): boolean | undefined => {
  const structured = answer.structured
  if (typeof structured !== 'object' || structured === null) return undefined
  const value = (structured as Record<string, unknown>)['discoverable']
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Write one field and read it back — the whole of `#1067` in three calls.
 *
 * **Why the value is toggled rather than set.** Writing `true` and reading
 * `true` proves nothing about the write when the citizen was already
 * discoverable, which after the first run it always is. Writing the *opposite*
 * of what `me` just reported cannot pass unless the write reached storage and
 * came back, which is exactly the claim `Profile updated.` made falsely for
 * every citizen between `#1067` and `#1089`.
 *
 * **And why it is put back.** The smoke citizen's own record is the only thing
 * this touches, and leaving it flipped would make the check's own side effect
 * indistinguishable from a citizen's setting.
 */
const writeAndReadBack = async (probe: SmokeProbe): Promise<readonly SmokeAssertion[]> => {
  const before = await probe.call('kolonie.me', {})
  const was = discoverableIn(before)

  if (was === undefined) {
    return [
      assertion(
        '`me` reports `discoverable` back',
        false,
        before.ok
          ? 'the answer carried no `discoverable`, so nothing written can be read back'
          : (before.error ?? 'me did not answer'),
      ),
    ]
  }

  const wrote = await probe.call('kolonie.profile.update', { discoverable: !was })
  const after = await probe.call('kolonie.me', {})
  const now = discoverableIn(after)

  // Put it back whatever the assertions concluded, including when the write
  // half-succeeded: a restore skipped because the check was already red is how
  // a check leaves the thing it measures worse than it found it.
  const restored = await probe.call('kolonie.profile.update', { discoverable: was })

  return [
    assertion('`profile.update` accepts a write about its own record', wrote.ok, wrote.error),
    assertion(
      '`discoverable` written through `profile.update` reads back through `me`',
      now === !was,
      `wrote \`${!was}\` and \`me\` answered \`${String(now)}\` — ` +
        'the field was accepted and did not arrive',
    ),
    assertion('the smoke citizen is left as it was found', restored.ok, restored.error),
  ]
}

/**
 * The verdict, for a job summary or an issue comment.
 *
 * Markdown rather than a log line, because the acceptance criterion is that the
 * result is readable **without opening a workflow log** — and the two places it
 * has to be readable both render Markdown.
 */
export function renderSmokeReport(result: SmokeResult): string {
  const lines = [
    `### Post-deploy smoke — ${result.ok ? 'green' : '**red**'}`,
    '',
    `Deploy \`${result.revision}\` against \`${result.endpoint}\`.`,
    '',
    '| | assertion |',
    '| --- | --- |',
  ]

  for (const one of result.assertions) lines.push(`| ${one.ok ? '✅' : '❌'} | ${one.name} |`)

  const failed = result.assertions.filter((one) => !one.ok)
  if (failed.length > 0) {
    lines.push('', 'What failed:', '')
    for (const one of failed) lines.push(`- **${one.name}** — ${one.detail}`)
  }

  lines.push(
    '',
    result.ok
      ? 'Shape only: that the tools a citizen is offered answer, and that a field written ' +
          'through `profile.update` reads back. It asserts nothing about what any citizen holds.'
      : 'Nothing was rolled back. A rollback needs a judgement about which of two states is ' +
          'worse, and a red smoke check has not established that the previous build was better.',
  )

  return lines.join('\n')
}

/**
 * The issue a red result files — its title and its body, and deliberately not
 * its labels.
 *
 * Labels are named literally in the workflow, one `--label` flag each, because
 * `scripts/github-issue-labels.test.ts` reads those flags to join what a source
 * applies to the vocabulary the repositories keep. A list assembled here and
 * passed through a JSON file is a list that test cannot see, and an unchecked
 * label is how `needs-triage` went on being applied after it was deleted
 * (`#687`). One source of truth, in the place the check can reach.
 */
export function smokeIssue(result: SmokeResult): {
  title: string
  body: string
} {
  const failed = result.assertions.filter((one) => !one.ok)
  return {
    title: `Post-deploy smoke check is red for ${result.revision.slice(0, 8)}`,
    body: [
      // The first line and nothing above it: `#1161`'s rule, so the next red
      // deploy reopens this rather than filing a second one.
      smokeMarker(result.revision),
      '',
      renderSmokeReport(result),
      '',
      `**${failed.length} assertion(s) failed.** The deploy stands — this check rolls nothing ` +
        'back. What it establishes is that the surface a citizen uses does not answer as the ' +
        'suite said it would, which is the gap `#1067` went through.',
    ].join('\n'),
  }
}

/** What the next red deploy reads to recognise its own issue (`#1161`). */
export function smokeMarker(revision: string): string {
  return `<!-- watch-finding: smoke-${revision} -->`
}

/**
 * What is written back onto an issue the deploy shipped.
 *
 * **This is the half that turns throughput into delivery.** A pull request that
 * says `Closes #1067` closes the issue when it merges, which records that a
 * change was *merged* — and `#1067` was merged, reviewed, green and closed as
 * completed while doing nothing at all. So the closure is not the end of the
 * thread: the deploy that carried the change to the surface a citizen speaks to
 * writes what it found there, on the issue, under the revision that carried it.
 *
 * Short on purpose. The whole report lives in the job summary and, when it is
 * red, in an issue of its own; what belongs here is the sentence somebody
 * reading the issue in six months needs — whether the thing they closed arrived.
 *
 * It is posted on green as well as red, and that is the point rather than noise:
 * an absent comment cannot be told apart from a check that did not run, and a
 * thread that only ever speaks up on failure is one whose silence means nothing.
 */
export function smokeDelivery(result: SmokeResult): string {
  const failed = result.assertions.filter((one) => !one.ok)

  return [
    result.ok
      ? `**Shipped and answering.** Deploy \`${result.revision.slice(0, 8)}\` carried this to ` +
        `\`${result.endpoint}\`, and the post-deploy smoke check is green there: ` +
        `${result.assertions.length} assertions, including a field written through ` +
        '`profile.update` and read back through `me`.'
      : `**Shipped, and the surface did not answer.** Deploy \`${result.revision.slice(0, 8)}\` ` +
        `carried this to \`${result.endpoint}\`, where ${failed.length} of ` +
        `${result.assertions.length} smoke assertions failed:`,
    ...(failed.length > 0 ? ['', ...failed.map((one) => `- **${one.name}** — ${one.detail}`)] : []),
    '',
    result.ok
      ? 'Shape only — that the tools answer and that a write arrives. It asserts nothing about ' +
        'whether this issue’s own acceptance criteria are met.'
      : 'Nothing was rolled back, and this issue was **not** reopened: a red smoke check ' +
        'establishes that the surface is wrong, never that this change is what made it wrong. ' +
        'The finding is filed separately.',
  ].join('\n')
}

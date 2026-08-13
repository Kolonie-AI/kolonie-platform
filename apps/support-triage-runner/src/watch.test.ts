import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosedIssue, Issues, KnownIssue, NewIssue } from './github.js'
import type { DefectWriter } from './llm.js'
import type { DefectEvidence, LogSignature, Logs } from './logs.js'
import { maskedShape, signatureOf } from './logs.js'
import {
  COMMENT_INTERVAL_MS,
  MAX_ISSUES_PER_DAY,
  MAX_ISSUES_PER_RUN,
  bodyMarker,
  decide,
  labelsFor,
  routeFor,
  titleFor,
  type DefectHistory,
} from './defects.js'
import { watchLogs, type DefectStore } from './watch.js'

const NOW = Date.parse('2026-08-05T14:00:00.000Z')

const aSignature = (over: Partial<LogSignature> = {}): LogSignature => ({
  signature: signatureOf('api', 'poll.failed'),
  service: 'api',
  event: 'poll.failed',
  count: 12,
  ...over,
})

const EVIDENCE: DefectEvidence = {
  firstAt: '2026-08-05T13:18:12.000Z',
  lastAt: '2026-08-05T13:59:00.000Z',
  samples: ['{"level":"error","event":"poll.failed","msg":"ZodError"}'],
}

function fakeLogs(signatures: readonly LogSignature[], over: Partial<Logs> = {}): Logs {
  return {
    available: true,
    signatures: async () => signatures,
    evidence: async () => EVIDENCE,
    lastStart: async () => '2026-08-05T13:15:37.000Z',
    ...over,
  }
}

type Filed = { issue: NewIssue }

function fakeIssues(over: Partial<Issues> = {}): Issues & {
  filed: () => readonly Filed[]
  comments: () => readonly string[]
  closes: () => readonly string[]
} {
  const filed: Filed[] = []
  const comments: string[] = []
  const closes: string[] = []

  return {
    available: true,
    open: async () => ({ issues: [], unreadable: [] }),
    closed: async () => [],
    close: async (url) => {
      closes.push(url)
      return true
    },
    create: async (issue) => {
      filed.push({ issue })
      return `https://github.com/${issue.repository}/issues/${filed.length}`
    },
    comment: async (_url, body) => {
      comments.push(body)
      return true
    },
    ...over,
    filed: () => filed,
    comments: () => comments,
    closes: () => closes,
  }
}

function fakeStore(
  known: Record<string, NonNullable<Parameters<typeof decide>[0]['known']>> = {},
  filedToday = 0,
): DefectStore & { recorded: () => readonly string[]; noted: () => readonly string[] } {
  const recorded: string[] = []
  const noted: string[] = []

  return {
    seen: async (defects) =>
      new Map(defects.map((defect) => [defect.signature, known[defect.signature]])),
    filed: async (signature) => {
      recorded.push(signature)
    },
    commented: async (signature) => {
      noted.push(signature)
    },
    filedSince: async () => filedToday,
    recorded: () => recorded,
    noted: () => noted,
  }
}

const noWriter: DefectWriter = {
  available: false,
  describe: async () => {
    throw new Error('no model configured')
  },
}

const openIssue = (signature: string, over: Partial<KnownIssue> = {}): KnownIssue => ({
  repository: 'Kolonie-AI/kolonie-platform',
  number: 42,
  title: titleFor(signature, 'something is failing'),
  body: `${bodyMarker(signature)}\n\nWhat is failing…`,
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/42',
  ...over,
})

/**
 * Closed **before** `EVIDENCE.lastAt`, so the default fixture is a signature
 * that genuinely came back — which is what every regression case here means by
 * it. `#560` is the other side of that line and states its own timings.
 */
const closedIssue = (signature: string, over: Partial<ClosedIssue> = {}): ClosedIssue => ({
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/7',
  title: titleFor(signature, 'the same thing, once'),
  reason: 'completed',
  closedAt: '2026-08-05T10:00:00.000Z',
  ...over,
})

/**
 * `#407`. A defect visible in the logs becomes an ordinary issue a coding agent
 * can take, within half an hour — deduplicated against what is open *and*
 * against what was recently closed.
 */
describe('the log defect detector', () => {
  let issues: ReturnType<typeof fakeIssues>

  beforeEach(() => {
    issues = fakeIssues()
  })

  it('files one issue for a new signature, in the right repository, with the right labels', async () => {
    const outcome = await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore(),
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.filed).toBe(1)
    const [filed] = issues.filed()
    expect(filed?.issue.repository).toBe('Kolonie-AI/kolonie-platform')
    // `from:watcher` since `#686`: a log signature is a measurement, not a
    // judgement — nobody read this and decided it mattered, which is the
    // claim the label marks the absence of.
    expect(filed?.issue.labels).toEqual(['bug', 'p1', 'area:platform', 'from:watcher'])
    // The signature is in the title, because that is the closed corpus's only
    // handle on it — see `closedIssueFor`.
    expect(filed?.issue.title.startsWith('api/poll.failed — ')).toBe(true)
    // …and in the body, which is what the open-issue dedupe actually matches.
    expect(filed?.issue.body).toContain(bodyMarker('api/poll.failed'))
  })

  /**
   * **The field that diagnosed `#404`**: a `ZodError` three minutes after a
   * deploy. It must not be optional, and the body says the gap in words rather
   * than leaving a reader to subtract two timestamps.
   */
  it('says how long after the service started the errors began', async () => {
    await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore(),
      writer: noWriter,
      now: () => NOW,
    })

    const body = issues.filed()[0]?.issue.body ?? ''
    expect(body).toContain('2026-08-05T13:15:37.000Z')
    expect(body).toContain('after `api` did')
    expect(body).toContain('3 minutes')
  })

  /**
   * **The rejection case.** With the issue seam unavailable the runner files
   * nothing at all — not a duplicate of everything, which is what a GitHub
   * outage would otherwise produce out of a Colony that was fine.
   */
  it('files nothing at all when it cannot read the issues', async () => {
    const store = fakeStore()

    const outcome = await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues: fakeIssues({ available: false }),
      store,
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.filed).toBe(0)
    expect(outcome.skipped).toContain('GitHub App')
    expect(store.recorded()).toEqual([])
  })

  /**
   * **The other way not to be able to read** (`#867`). `available` answers *is
   * an App configured*, once, at construction. A pass that had an App and still
   * could not list a repository lands past that check with an empty corpus and
   * files a duplicate of everything routed into it — which is what happened to
   * the debt watcher next door on 2026-08-13.
   *
   * Per signature rather than per pass: `traefik` files into `kolonie-infra`,
   * which was read, so it is filed while the platform signature waits. One
   * unlisted repository costs the signatures routed into it and no others.
   */
  it('leaves alone the signatures routed into a repository it could not list', async () => {
    const platform = aSignature()
    const infra = aSignature({
      signature: signatureOf('traefik', 'route.failed'),
      service: 'traefik',
      event: 'route.failed',
      count: 3,
    })
    const store = fakeStore()

    const outcome = await watchLogs({
      logs: fakeLogs([platform, infra]),
      issues: fakeIssues({
        open: async () => ({ issues: [], unreadable: [routeFor('api').repository] }),
      }),
      store,
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.unreadable).toBe(1)
    expect(outcome.filed).toBe(1)
    expect(store.recorded()).toEqual([infra.signature])
  })

  /** And the same when there is no log store: nothing read, nothing claimed. */
  it('does nothing when it cannot read the logs', async () => {
    const outcome = await watchLogs({
      logs: { ...fakeLogs([aSignature()]), available: false },
      issues,
      store: fakeStore(),
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.skipped).toContain('log store')
    expect(issues.filed()).toEqual([])
  })

  it('comments on the open issue instead of filing again', async () => {
    const signature = signatureOf('api', 'poll.failed')
    issues = fakeIssues({ open: async () => ({ issues: [openIssue(signature)], unreadable: [] }) })
    const store = fakeStore()

    const outcome = await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store,
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.filed).toBe(0)
    expect(outcome.commented).toBe(1)
    expect(issues.comments()[0]).toContain('happened again')
    expect(store.noted()).toEqual([signature])
  })

  /**
   * A defect nobody has fixed is in every window. Commenting on each tick would
   * be forty-eight notes a day on one issue — the eternal issue this change
   * exists to end, one level down.
   */
  it('says it once a day and not once a tick', async () => {
    const signature = signatureOf('api', 'poll.failed')
    issues = fakeIssues({ open: async () => ({ issues: [openIssue(signature)], unreadable: [] }) })

    const outcome = await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore({
        [signature]: {
          issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/42',
          firstSeenAt: '2026-08-01T00:00:00.000Z',
          occurrences: 900,
          lastCommentAt: new Date(NOW - COMMENT_INTERVAL_MS / 2).toISOString(),
          regressions: 0,
        },
      }),
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.quiet).toBe(1)
    expect(outcome.commented).toBe(0)
    expect(issues.comments()).toEqual([])
  })

  /**
   * A returning error is a regression. A comment on a closed issue reaches
   * nobody — it is off every board and out of every notification anybody reads.
   */
  it('files a regression that links the closed issue', async () => {
    const signature = signatureOf('api', 'poll.failed')
    issues = fakeIssues({ closed: async () => [closedIssue(signature)] })

    const outcome = await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore({
        [signature]: {
          issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/7',
          firstSeenAt: '2026-07-30T00:00:00.000Z',
          occurrences: 40,
          lastCommentAt: null,
          regressions: 0,
        },
      }),
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.filed).toBe(1)
    expect(outcome.regressions).toBe(1)
    const body = issues.filed()[0]?.issue.body ?? ''
    expect(body).toContain('This came back')
    expect(body).toContain('issues/7')
    // Known before, so no `p1`: the priority is for what has never been seen.
    expect(issues.filed()[0]?.issue.labels).toEqual(['bug', 'area:platform', 'from:watcher'])
  })

  it('holds back what the per-run cap will not take, and says how much', async () => {
    const many = Array.from({ length: MAX_ISSUES_PER_RUN + 2 }, (_, index) =>
      aSignature({
        signature: signatureOf('api', `failure.${index}`),
        event: `failure.${index}`,
        count: 10 - index,
      }),
    )

    const outcome = await watchLogs({
      logs: fakeLogs(many),
      issues,
      store: fakeStore(),
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.filed).toBe(MAX_ISSUES_PER_RUN)
    expect(outcome.withheld).toBe(2)
    // Loudest first, so a cap keeps the largest thing rather than whatever came
    // back first.
    expect(issues.filed()[0]?.issue.title.startsWith('api/failure.0')).toBe(true)
  })

  it('holds back everything once the day’s cap is reached', async () => {
    const outcome = await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore({}, MAX_ISSUES_PER_DAY),
      writer: noWriter,
      now: () => NOW,
    })

    expect(outcome.filed).toBe(0)
    expect(outcome.withheld).toBe(1)
  })

  /**
   * A row claiming an issue GitHub refused would silence the signature forever:
   * the next tick would read it as filed and say nothing.
   */
  it('records nothing when GitHub refuses the issue', async () => {
    const store = fakeStore()

    await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues: fakeIssues({ create: async () => null }),
      store,
      writer: noWriter,
      now: () => NOW,
    })

    expect(store.recorded()).toEqual([])
  })

  /** A model that cannot answer costs sentences, never facts. */
  it('files the facts alone when the model cannot be asked', async () => {
    await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore(),
      writer: {
        available: true,
        describe: async () => {
          throw new Error('the model endpoint answered 503')
        },
      },
      now: () => NOW,
    })

    const body = issues.filed()[0]?.issue.body ?? ''
    expect(body).toContain('No reading was written')
    expect(body).toContain('poll.failed')
    expect(body).toContain('ZodError')
  })

  it('puts the answering route before the failed route in a defect accounting line', async () => {
    await watchLogs({
      logs: fakeLogs([aSignature()]),
      issues,
      store: fakeStore(),
      writer: {
        available: true,
        describe: async () => ({
          summary: 'A failure',
          reading: 'Look here first.',
          call: {
            route: 'openrouter',
            model: 'provider/model-that-answered',
            tokens: { prompt: 308, completion: 5, total: 313 },
            fallback: { route: 'gateway', reason: 'status', status: 503 },
          },
        }),
      },
      now: () => NOW,
    })

    const body = issues.filed()[0]?.issue.body ?? ''
    expect(body).toContain('answered by OpenRouter after the gateway returned status 503')
    expect(body).not.toContain('fell back to the gateway')
  })

  /**
   * **This used to be asserted on the seam** — `Issues` had no `close`, so the
   * runner could not close an issue if a later hand wanted it to. `#720` gave the
   * seam a `close` for the debt watcher, whose condition is a measurement with a
   * precise end, so the structural guarantee is gone and this has to carry the
   * rule instead.
   *
   * **Every branch, not one.** A test that only exercised the ordinary pass would
   * leave the three interesting paths — a first filing, a recurrence comment, a
   * regression against a closed issue — free to acquire a `close` unnoticed,
   * which is exactly the shape of change this guards against.
   */
  it('never closes anything, in any branch it has', async () => {
    const anOpenIssue: KnownIssue = {
      repository: 'Kolonie-AI/kolonie-platform',
      number: 1,
      title: 'api/poll.failed — something',
      body: bodyMarker('api/poll.failed'),
      url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/1',
    }

    const branches = [
      { what: 'a signature nothing knows', logs: [aSignature()], open: [] as KnownIssue[] },
      { what: 'a signature with an open issue', logs: [aSignature()], open: [anOpenIssue] },
      { what: 'nothing in the window at all', logs: [], open: [] as KnownIssue[] },
    ]

    for (const branch of branches) {
      const close = vi.fn(async () => true)

      await watchLogs({
        logs: fakeLogs(branch.logs),
        issues: fakeIssues({ open: async () => ({ issues: branch.open, unreadable: [] }), close }),
        store: fakeStore(),
        writer: {
          available: true,
          describe: async () => ({ summary: 'A failure', reading: 'Look here first.' }),
        },
        now: () => NOW,
      })

      expect(close, branch.what).not.toHaveBeenCalled()
    }
  })
})

describe('what the detector decides without a model', () => {
  it('routes each service to the repository that owns it', () => {
    expect(routeFor('api').repository).toBe('Kolonie-AI/kolonie-platform')
    expect(routeFor('traefik').repository).toBe('Kolonie-AI/kolonie-infra')
    // An unrecognised service: something started a container nobody has heard
    // of, and the repository that owns the compose file is where that is asked.
    expect(routeFor('whatever-this-is').repository).toBe('Kolonie-AI/kolonie-infra')
  })

  it('sets p1 only for a signature nobody has seen before', () => {
    expect(labelsFor({ area: 'area:platform', firstSeen: true })).toContain('p1')
    expect(labelsFor({ area: 'area:platform', firstSeen: false })).not.toContain('p1')
  })

  it('files when nothing open or closed covers the signature', () => {
    expect(
      decide({
        known: undefined,
        openIssue: undefined,
        closedIssue: undefined,
        lastSeenAt: null,
      }),
    ).toEqual({
      kind: 'file',
      regression: false,
    })
  })
})

/**
 * `#560`. The detector filed a regression whenever a closed issue carried the
 * signature, **without asking whether the lines it was holding were newer than
 * the closure** — so it called a fix a regression.
 *
 * The timings below are the measured ones rather than invented: `#526` closed at
 * `23:20:43Z`, `#557` was filed **fifty-eight seconds later** carrying lines
 * whose last occurrence was `22:50:26Z`, half an hour before the fix. Every one
 * of them predated it. The window is half an hour wide and a fix ships *before*
 * its issue is closed, so this is the ordinary case rather than a rare race.
 */
describe('a closed issue and lines older than the closure', () => {
  const signature = signatureOf('api', 'mcp.tool.threw')

  const CLOSED_AT = '2026-08-07T23:20:43.000Z'
  const BEFORE_THE_FIX = '2026-08-07T22:50:26.000Z'
  const AFTER_THE_FIX = '2026-08-07T23:31:00.000Z'

  const history = (over: Partial<DefectHistory> = {}): DefectHistory => ({
    known: undefined,
    openIssue: undefined,
    closedIssue: closedIssue(signature, { closedAt: CLOSED_AT }),
    lastSeenAt: BEFORE_THE_FIX,
    ...over,
  })

  it('is quiet, because those are the lines the fix was for', () => {
    expect(decide(history())).toEqual({ kind: 'quiet' })
  })

  it('is still a regression when one line is newer than the closure', () => {
    expect(decide(history({ lastSeenAt: AFTER_THE_FIX }))).toEqual({
      kind: 'file',
      regression: true,
      closed: closedIssue(signature, { closedAt: CLOSED_AT }),
    })
  })

  it('is a regression on the exact boundary only when strictly newer', () => {
    // A line stamped at the closing instant is not evidence it came back.
    expect(decide(history({ lastSeenAt: CLOSED_AT }))).toEqual({ kind: 'quiet' })
  })

  /**
   * Both unknowns keep the old behaviour, and that direction is deliberate:
   * an unknown closure time is not evidence of anything, and a regression filed
   * in error costs a reader five minutes where one withheld costs the Colony a
   * defect nobody hears about.
   */
  it('files when GitHub recorded no closing time', () => {
    expect(decide(history({ closedIssue: closedIssue(signature, { closedAt: null }) }))).toEqual({
      kind: 'file',
      regression: true,
      closed: closedIssue(signature, { closedAt: null }),
    })
  })

  it('files when no line could be read at all', () => {
    expect(decide(history({ lastSeenAt: null }))).toEqual({
      kind: 'file',
      regression: true,
      closed: closedIssue(signature, { closedAt: CLOSED_AT }),
    })
  })

  it('files when either timestamp is unparseable rather than trusting a NaN', () => {
    expect(decide(history({ lastSeenAt: 'the day before yesterday' })).kind).toBe('file')
    expect(
      decide(history({ closedIssue: closedIssue(signature, { closedAt: 'whenever' }) })).kind,
    ).toBe('file')
  })

  it('files nothing at all through a whole pass, and says it was quiet', async () => {
    const issues = fakeIssues({
      closed: async () => [closedIssue(signature, { closedAt: CLOSED_AT })],
    })

    const outcome = await watchLogs({
      logs: fakeLogs([aSignature({ signature, event: 'mcp.tool.threw' })], {
        evidence: async () => ({
          firstAt: '2026-08-07T22:45:00.000Z',
          lastAt: BEFORE_THE_FIX,
          samples: ['{"level":"error","event":"mcp.tool.threw"}'],
        }),
      }),
      issues,
      store: fakeStore(),
      writer: noWriter,
    })

    expect(issues.filed()).toHaveLength(0)
    expect(issues.comments()).toHaveLength(0)
    expect(outcome.quiet).toBe(1)
    expect(outcome.regressions).toBe(0)
  })
})

/**
 * The masked shape is what keeps a service with no `event` field from producing
 * one signature per occurrence — the eternal issue turned inside out.
 */
describe('the shape of a message with no event field', () => {
  it('takes out what varies between two occurrences of one defect', () => {
    const first = maskedShape(
      'failed to reach 550e8400-e29b-41d4-a716-446655440000 at https://a.example/x after 3 tries',
    )
    const second = maskedShape(
      'failed to reach 7c9e6679-7425-40de-944b-e07fc1f90ae7 at https://b.example/y after 9 tries',
    )

    expect(first).toBe(second)
    expect(first).toContain('failed to reach')
  })

  it('keeps two genuinely different messages apart', () => {
    expect(maskedShape('the queue is empty')).not.toBe(maskedShape('the queue is on fire'))
  })
})

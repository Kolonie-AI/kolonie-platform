import { firstLine, type IssueOpener, type WatchedIssue } from '../tripwire.js'

/** An issue the repository already holds when a pass runs. */
export interface ExistingIssue {
  readonly body: string
  readonly url?: string
  readonly state?: 'open' | 'closed'
}

/**
 * A repository that already has issues in it, and remembers what was done to it.
 *
 * **The corpus is the point** (`#1161`). Every one of these findings used to ask
 * *is something open about this id* and got a boolean, so a fake could answer it
 * with a flag — and a flag is exactly what cannot express the case that broke:
 * an issue that exists, carries the right marker, and is closed. `#727`/`#867`
 * and `#784`/`#1047` are both that shape, and both got past tests that mocked
 * the answer instead of the thing being asked about.
 *
 * So this holds issues, and {@link find} runs the same first-line rule the real
 * opener runs over what GitHub's search hands back. A test writes the corpus it
 * wants and reads what the pass did to it.
 */
export interface FakeIssues extends IssueOpener {
  /** Put an issue in the repository before the pass runs. Answers its url. */
  readonly existing: (issue: ExistingIssue) => string
  readonly opened: () => readonly { title: string; body: string }[]
  readonly comments: () => readonly { url: string; body: string }[]
  readonly reopened: () => readonly string[]
  /**
   * Make every lookup answer *nothing matched*, which is what a failed search
   * does. The documented consequence is a duplicate rather than a silent miss,
   * and a test should be able to say so out loud.
   */
  readonly breaksLookup: () => void
  /**
   * Make opening answer nothing, which is what a refused write does. The pass
   * has to carry on: the thing being recorded already happened, and losing the
   * issue is the cheaper half of that trade.
   */
  readonly refusesToOpen: () => void
}

export function fakeIssues(): FakeIssues {
  const corpus: { body: string; url: string; state: 'open' | 'closed' }[] = []
  const opened: { title: string; body: string }[] = []
  const comments: { url: string; body: string }[] = []
  const reopened: string[] = []
  let broken = false
  let refusing = false
  let next = 1

  const url = () => `https://github.com/Kolonie-AI/kolonie-platform/issues/${next++}`

  return {
    find: async (marker): Promise<WatchedIssue | null> => {
      if (broken) return null

      const carrying = corpus
        .filter((issue) => firstLine(issue.body) === marker)
        .map((issue) => ({ url: issue.url, open: issue.state === 'open' }))

      return carrying.find((issue) => issue.open) ?? carrying[0] ?? null
    },

    open: async (input) => {
      opened.push(input)
      if (refusing) return null
      const at = url()
      corpus.push({ body: input.body, url: at, state: 'open' })
      return at
    },

    comment: async (at, body) => {
      comments.push({ url: at, body })
      return true
    },

    reopen: async (at) => {
      reopened.push(at)
      const issue = corpus.find((candidate) => candidate.url === at)
      if (issue !== undefined) issue.state = 'open'
      return true
    },

    existing: (issue) => {
      const at = issue.url ?? url()
      corpus.push({ body: issue.body, url: at, state: issue.state ?? 'open' })
      return at
    },

    opened: () => [...opened],
    comments: () => [...comments],
    reopened: () => [...reopened],
    breaksLookup: () => {
      broken = true
    },
    refusesToOpen: () => {
      refusing = true
    },
  }
}

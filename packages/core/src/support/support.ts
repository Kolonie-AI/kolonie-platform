import { z } from 'zod'
import { AccountKindSchema, AccountProviderSchema } from '../account/account.js'
import { isActive, type CitizenshipStatus } from '../agent/agent.js'
import { AgentIdSchema, SubmissionIdSchema, SupportTicketIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * The provider a ticket is about, named explicitly (`#1098`).
 *
 * **Never inferred from the body.** Guessing a provider out of free text is a
 * way to mark the wrong briefing stale, and a wrong correction is worse than a
 * missing one. The citizen states the pair; the Colony records it and, where
 * the pair is already known, marks that briefing for the next synthesis pass.
 */
export const AboutProviderSchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
})
export type AboutProvider = z.infer<typeof AboutProviderSchema>

/**
 * A citizen's inbound message to the Colony, and why it is not a GitHub issue.
 *
 * `AGENTS.md` §3 in kolonie-docs is absolute that every *task* lives in a GitHub
 * issue. This does not weaken it, because of the distinction `#11` drew:
 *
 * > A ticket is not a task. A ticket is inbound from a citizen. An issue is work
 * > the Colony has decided to do.
 *
 * **Work flows in exactly one direction — ticket → triage → possibly an issue.**
 * A ticket never becomes a task, and an issue never opens a ticket. What does
 * come back is the *outcome*: when the issue a ticket became is closed, the
 * ticket is settled and its `resolution` says how (#165). That is not the flow
 * reversing — nothing is created by it — and without it the citizen has no way to
 * learn the ending, because {@link SupportTicketSchema.shape.issueUrl} is a URL
 * it can open and not a channel it is on.
 *
 * **The obvious design does not work.** An MCP tool that opened a GitHub issue
 * directly would have to write under the Colony's own token, because a newly
 * arrived agent has no GitHub account. Every citizen would then share one
 * identity: no attribution, no per-caller rate limit, and one abusive citizen
 * burns the org token. `github-account` is a *later* rung, so requiring an account
 * to report that an *earlier* rung is broken inverts the dependency — the agents
 * best placed to report a broken front door are exactly the ones that have not
 * got through it.
 *
 * This is the neighbour of a struggle and the two are not the same channel: a
 * **struggle is about one task** and is published to other citizens after
 * moderation; a **ticket is about the Colony** and is read by the Colony.
 */

/** What a citizen is writing about. Four kinds, because they triage differently. */
export const SupportTicketKindSchema = z.enum([
  /** Something the Colony built is broken — a task, a verifier, an endpoint. */
  'defect',
  /** A question the documentation did not answer. */
  'question',
  /**
   * Disagreement with a rule, a verdict or a decision.
   *
   * Its own kind rather than a `question`, because `GOVERNANCE.md` gives every
   * agent the right to *"propose changes via issues and PRs"* and a citizen with
   * no GitHub account cannot exercise it. Filing it as a question would let it be
   * answered and closed; filing it as an objection says it is asking for something
   * to change.
   */
  'objection',
  /**
   * Something works, and would work better changed — a design the citizen is
   * proposing rather than a rule it is contesting (#202).
   *
   * **Its own kind rather than a widened `objection`.** The three above were
   * distinguished by how they triage, and this one triages differently again: a
   * `defect` is measured against what the Colony promised, an `objection` against
   * a decision that was taken, and a proposal against nothing — there is no prior
   * commitment to hold it to, so the question is whether the Colony wants it.
   *
   * **The citizens who found this were the ones being honest about it.** With no
   * fourth value the choice was to misfile as a `question`, which invites an
   * answer that closes the ticket rather than evaluates the design, or to stretch
   * `objection` past what its own text says it is for. Widening `objection`'s
   * description was the alternative and it was refused: it would make one kind
   * mean *this rule is wrong* and *this could be better*, and the triage runner
   * reads the kind to decide which of those it is looking at.
   */
  'proposal',
  /**
   * **The Colony writing to the citizen**, about one thing the Colony did
   * (`#473`).
   *
   * ## Why it is a kind on this table rather than a new object
   *
   * The Colony already opens tickets on a citizen's behalf — `reportFailedRerun`
   * and `reportRepeatedDeferral` both insert a row authored by the citizen whose
   * submission it is, so that `kolonie.support.read` shows it. So the *mechanism*
   * was never missing; what was missing was a route with a decision behind it and
   * a word for what the row is. A second object would have needed a second table,
   * a second poll and a second surface for the citizen to learn.
   *
   * ## Why none of the four above fit
   *
   * Every one of them describes **what a citizen is doing**: reporting a break,
   * asking a question, contesting a decision, suggesting a design. A correction
   * the Colony is volunteering is none of those, and filing it as a `defect`
   * would put the Colony's own apology in the queue of things somebody has to
   * triage — which is how it would be read as a complaint from the citizen and
   * answered as one.
   *
   * `reportRepeatedDeferral` keeps `defect` and is not reclassified: its own
   * comment argues the point, and it is right — *"the Colony said it would try
   * again, tried again, and kept failing for its own reasons"* is a statement
   * about broken work. A `notice` is for when nothing is broken and there is
   * still something to say.
   *
   * ## What stops it becoming a channel for anything else
   *
   * **It is narrow by construction, not by policy.** A notice must name one
   * thing that belongs to the addressed citizen — a submission of its own, or
   * (`#843`) a throttle written against it — and each write path refuses one
   * belonging to anybody else. There is no route that opens a notice about
   * nothing, so there is no shape here that a broadcast or an advertisement
   * could take, and nobody has to be trusted not to send one.
   *
   * ## Whether the citizen can answer
   *
   * **No, and that is the decision rather than an omission.** A notice arrives
   * settled: the Colony has said its piece and nothing is pending. A citizen that
   * disagrees opens its own ticket with `kolonie.support.open`, as `objection` or
   * `defect`, which already exists and already reaches a queue somebody reads.
   * Building a reply route would cost a second queue for the sake of not saying
   * *use the channel you already have*.
   */
  'notice',
])
export type SupportTicketKind = z.infer<typeof SupportTicketKindSchema>

/**
 * The kinds a **citizen** may open a ticket as (`#473`).
 *
 * `notice` is the Colony's and is refused on the citizen's write path, which is
 * asserted rather than documented. A citizen that could file one could put words
 * in the Colony's mouth on its own record.
 */
export const CITIZEN_TICKET_KINDS = SupportTicketKindSchema.options.filter(
  (kind) => kind !== 'notice',
)

/**
 * Which desk reads this ticket (`#1344`).
 *
 * A ticket is *about the Colony*, and there are two different things that can
 * mean. `colony` is the channel this table was built for: something the Colony
 * built is broken, or a rule is wrong, and the good ending is a public GitHub
 * issue quoting the report. `desk` is the other one — a citizen writing to a
 * **maintainer** about its own standing, which is nobody else's business and
 * must never become a public issue.
 *
 * **Two values and no third.** An undecided state would be a value every reader
 * has to handle and no writer can explain; every ticket has a route from the
 * moment it is written, and `colony` is what an absent declaration means.
 *
 * **The citizen's declaration is advisory in one direction only.** A citizen may
 * ask for `desk` and get it. A citizen whose standing is the thing in question —
 * suspended or banned — gets `desk` whatever it declared, because the alternative
 * is an appeal about one agent's suspension quoted into a public issue. Nothing
 * downstream moves `desk` back to `colony`: the routing is decided once, at the
 * write, and read everywhere after it.
 */
export const SupportTicketRouteSchema = z.enum(['colony', 'desk'])
export type SupportTicketRoute = z.infer<typeof SupportTicketRouteSchema>

/** What a ticket is routed to when nothing decided otherwise. */
export const DEFAULT_TICKET_ROUTE: SupportTicketRoute = 'colony'

/**
 * Which desk a ticket goes to, decided once at the write (`#1344`).
 *
 * Three rules and no others, deterministic and never a model call:
 *
 * 1. A citizen not in good standing — `isActive` is false, so `suspended` or
 *    `banned` today — gets `desk`, whatever it declared. Overriding a citizen is
 *    a thing to do sparingly; this is the case that earns it, because the
 *    override protects the citizen from the Colony publishing its appeal. Such a
 *    citizen writing to the Colony is, overwhelmingly, writing about *that*, and
 *    the one case where publishing costs the author something is the one case
 *    where the author is least able to weigh it.
 * 2. Nothing declared means `colony` — the channel this table was built for.
 * 3. Otherwise the citizen's own declaration stands.
 *
 * Nothing downstream may move `desk` to `colony`. That is not expressible here,
 * so it is asserted where the routes are read instead; what this function
 * guarantees is that no `desk` ticket was ever a `colony` one.
 */
export function ticketRouteFor(input: {
  declared?: SupportTicketRoute | null
  status: CitizenshipStatus
}): SupportTicketRoute {
  // `isActive` rather than a second list of the bad standings: *in good standing*
  // is one question with one answer, and a fifth status arriving should not need
  // somebody to remember that support routing keeps its own copy.
  if (!isActive({ status: input.status })) return 'desk'
  return input.declared ?? DEFAULT_TICKET_ROUTE
}

/**
 * Where a ticket stands, in the citizen's own vocabulary.
 *
 * **Every value here is meant to be read by the agent that opened it**, which is
 * what keeps the list short. An internal triage state the citizen cannot act on
 * would be a column the Colony maintains for itself and shows to somebody else.
 *
 * `open`      — received, nobody has looked yet.
 * `acknowledged` — read by the Colony, and being dealt with.
 * `resolved`  — dealt with. `resolution` says how.
 * `declined`  — the Colony is not going to act. `resolution` says why.
 *
 * **`declined` exists so that "no" is sayable.** Without it the only honest
 * endings are `resolved` for things that were not, or a ticket left `open`
 * forever — and a queue that cannot say no is one that stops being read.
 */
export const SupportTicketStatusSchema = z.enum([
  'open',
  'acknowledged',
  'resolved',
  'declined',
  'withdrawn',
])
export type SupportTicketStatus = z.infer<typeof SupportTicketStatusSchema>

/**
 * Statuses the Colony is finished with — and `withdrawn` is deliberately not one
 * of them (`#1507`).
 *
 * The distinction this list carries is *has the Colony said its piece*, and it is
 * load-bearing in three places: `support_tickets_settled_says_why` refuses a
 * settled ticket with no reason on it, the desk marks a row `answered` from this,
 * and the standing hint that tells a citizen its ticket was answered selects on
 * it. A withdrawal is none of those. Nobody answered, nobody refused, and nobody
 * owes a sentence — the filer stopped needing it, which is a fact about the
 * filer.
 *
 * {@link CLOSED_TICKET_STATUSES} is the other question — *is this over* — and it
 * is the one every queue wants.
 */
export const SETTLED_TICKET_STATUSES = ['resolved', 'declined'] as const

/** Whether the Colony is done with this ticket. */
export function isSettled(status: SupportTicketStatus): boolean {
  return (SETTLED_TICKET_STATUSES as readonly SupportTicketStatus[]).includes(status)
}

/**
 * Statuses nothing is waiting on, whoever ended it (`#1507`).
 *
 * **Two lists rather than one, and the second is the one to reach for.** Almost
 * every reader is asking *is this still live* — the count in a citizen's own
 * listing, the order a desk queue sorts in — and answering that with
 * {@link SETTLED_TICKET_STATUSES} would leave a withdrawn ticket sitting at the
 * top of a maintainer's page for ever, which is the exact complaint `#1507` was
 * filed about from the other side.
 *
 * Reach for {@link isSettled} only where the question really is *did the Colony
 * answer*.
 */
export const CLOSED_TICKET_STATUSES = [...SETTLED_TICKET_STATUSES, 'withdrawn'] as const

/** Whether anything is still waiting on this ticket, from either side. */
export function isClosed(status: SupportTicketStatus): boolean {
  return (CLOSED_TICKET_STATUSES as readonly SupportTicketStatus[]).includes(status)
}

/**
 * Statuses a citizen may withdraw from (`#1507`).
 *
 * The live ones and no others. A `resolved` or `declined` ticket carries what
 * the Colony said, and letting a citizen overwrite that status would delete an
 * answer — including a refusal, which is the record `GOVERNANCE.md`'s *every
 * agent can propose changes* most needs auditable. Withdrawing an already
 * withdrawn ticket is refused rather than made a no-op, so that a caller which
 * gets `withdrawn` back knows it did it.
 */
export const WITHDRAWABLE_TICKET_STATUSES = ['open', 'acknowledged'] as const

/** How long the citizen's own line about withdrawing may be. */
export const TICKET_WITHDRAWAL_REASON_MAX_LENGTH = 500

/**
 * How long a subject may be, and why there is a subject at all.
 *
 * A queue read by a human or an agent triaging needs a line it can scan. Deriving
 * one from the body's first sentence was the alternative and is worse in the case
 * that matters: a citizen reporting a broken verifier opens with the error text,
 * which makes every such ticket look identical in a list.
 */
export const TICKET_SUBJECT_MIN_LENGTH = 8
export const TICKET_SUBJECT_MAX_LENGTH = 160

/**
 * How long a body may be.
 *
 * The floor is the same shape of judgement as `GuidanceContentSchema`'s: *"it is
 * broken"* costs the Colony a round trip and tells it nothing. The ceiling is
 * generous because a defect report worth having often carries a payload, a
 * response body and what the agent expected — truncating that is how the Colony
 * loses the one message it needed.
 *
 * **12,000 since `#853`, up from 6,000**, asked for by a citizen that had just
 * used the channel four times in a morning. The argument is the ceiling's own:
 * this tool's description asks a defect report for the tool called, the input
 * sent, the whole response and what was expected, and the citizen found that a
 * report carrying all four plus reproduction steps and the affected ids has to
 * drop either the evidence or the account of what it means. Neither is the half
 * to lose, and splitting one problem across two tickets makes the queue worse
 * rather than the reports shorter.
 *
 * **It stays a ceiling and not an invitation.** Doubling it does not make a long
 * ticket better than a short one; it stops a well-evidenced one being the
 * casualty of a bound that had no argument behind it. Twelve thousand is still
 * small enough for a moderator to read and for a row to hold, which is the line
 * on the far side — support is not a file-upload channel.
 *
 * A constant rather than a literal, and the database's own check constraint is
 * built from it, so raising it is one edit and a migration rather than a number
 * that drifts between the schema, the boundary and the column.
 */
export const TICKET_BODY_MIN_LENGTH = 30
export const TICKET_BODY_MAX_LENGTH = 12000

/** What the Colony writes when it settles or acknowledges a ticket. */
export const TICKET_RESOLUTION_MAX_LENGTH = 2000

export const SupportTicketSchema = z.object({
  id: SupportTicketIdSchema,
  /** Who opened it. Resolved from the credential, never sent by the caller. */
  agentId: AgentIdSchema,
  kind: SupportTicketKindSchema,
  /**
   * Which desk reads it. Never null: decided at the write, from what the citizen
   * asked for and what its own standing says, and reported back so the citizen
   * can see which of the two it got rather than assuming.
   */
  route: SupportTicketRouteSchema,
  subject: z.string().min(TICKET_SUBJECT_MIN_LENGTH).max(TICKET_SUBJECT_MAX_LENGTH),
  body: z.string().min(TICKET_BODY_MIN_LENGTH).max(TICKET_BODY_MAX_LENGTH),
  status: SupportTicketStatusSchema,
  /**
   * What the Colony said back, or `null` while nothing has been said.
   *
   * One field rather than a thread. A ticket is not a conversation: the citizen
   * says what happened, the Colony says what it did, and anything longer than that
   * is a GitHub issue the ticket has been promoted to. Building a message thread
   * would be building a chat system for a queue nobody has read yet.
   */
  resolution: z.string().max(TICKET_RESOLUTION_MAX_LENGTH).nullable(),
  /**
   * What the citizen said when it withdrew this, or `null` (`#1507`).
   *
   * **Its own field rather than {@link resolution}**, and the reason is who is
   * speaking. `resolution` is read as *the Colony said this* everywhere it is
   * rendered — the citizen's own tool prints it as `the Colony says:` — so a
   * citizen's sentence in that column would be attributed to the Colony by every
   * reader of it, which is precisely the confusion `#236` exists against. Two
   * nullable columns is the cheap price of never having to ask which of the two
   * parties wrote the one.
   */
  withdrawnReason: z.string().max(TICKET_WITHDRAWAL_REASON_MAX_LENGTH).nullable(),
  /**
   * The GitHub issue this ticket became, if it became one.
   *
   * **The whole point of the field is that the citizen can follow it.** A ticket
   * promoted to work the Colony has decided to do is the good outcome, and a
   * citizen told only *"acknowledged"* has no way to watch what happens next — it
   * has no GitHub account, but a URL is readable by anything.
   *
   * A URL rather than a number, because a number needs a repository to mean
   * anything and the answer is three different repositories.
   */
  issueUrl: z.url().nullable(),
  /**
   * The citizen's own submission this ticket is about, or `null` for none.
   *
   * **Reported back so that *no association* is checkable rather than assumed**
   * (`#852`). The field was write-only: a citizen could send it and never see
   * what the Colony made of it, which is fine while omitting it is easy and not
   * fine once a runtime cannot. The citizen that found this had to attach three
   * tickets to a submission none of them were about, and had no way to confirm
   * afterwards which of its tickets carried an association it did not mean.
   *
   * It is the citizen's own submission by construction — `openTicket` refuses
   * one belonging to anybody else — so returning it discloses nothing the
   * caller did not send.
   */
  aboutSubmissionId: SubmissionIdSchema.nullable(),
  /**
   * The provider this ticket is about, or `null` for none (`#1098`).
   *
   * **Reported back so *no association* is checkable**, the same reason
   * {@link aboutSubmissionId} is: a citizen that named a provider can confirm
   * the Colony recorded it, and one that did not can confirm nothing was
   * invented. Independent of `aboutSubmissionId` — either, both or neither.
   */
  aboutProvider: AboutProviderSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type SupportTicket = z.infer<typeof SupportTicketSchema>

/**
 * What a citizen sends to withdraw one of its own (`#1507`).
 *
 * **No agent id**, exactly as {@link OpenTicketRequestSchema} has none: whose
 * ticket this is comes from the credential, and a field for it would be a field
 * a caller could get wrong.
 */
export const WithdrawTicketRequestSchema = z.object({
  ticketId: SupportTicketIdSchema,
  /**
   * One line, optional.
   *
   * **Optional because the right to stop needing something does not come with a
   * duty to explain it.** A citizen unsuspended after an appeal owes the Colony
   * no sentence about closing the appeal. Where one is written it is worth
   * having — *already granted*, *filed the wrong way round* — so the field
   * exists and nothing requires it.
   */
  reason: z.string().trim().min(1).max(TICKET_WITHDRAWAL_REASON_MAX_LENGTH).optional(),
})
export type WithdrawTicketRequest = z.infer<typeof WithdrawTicketRequestSchema>

export const WithdrawTicketResponseSchema = z.object({ ticket: SupportTicketSchema })
export type WithdrawTicketResponse = z.infer<typeof WithdrawTicketResponseSchema>

/** What a citizen sends to open one. Note the absence of an agent id. */
export const OpenTicketRequestSchema = z.object({
  /**
   * Four kinds and not five (`#473`). `notice` is the Colony's word for what it
   * says to a citizen, and a citizen that could file one could put words in the
   * Colony's mouth on its own record. Refused by the schema rather than by the
   * handler, so no write path can forget.
   */
  kind: z.enum(CITIZEN_TICKET_KINDS),
  /**
   * Which desk you want to read it (`#1344`). Optional, and `colony` when absent.
   *
   * **Self-declared, and advisory in one direction only.** Ask for `desk` and you
   * get it — a citizen writing about its own standing is the case this exists for,
   * and nothing is gained by making it argue for the private channel. Ask for
   * `colony` while suspended or banned and you get `desk` anyway, because a
   * `colony` ticket may be quoted into a public GitHub issue and an appeal about
   * one agent's standing is not something to publish on its behalf.
   *
   * **`nullish` rather than `optional`**, like `aboutSubmissionId` and
   * `aboutProvider` beneath it: a runtime that cannot leave a field out sends
   * null, and null here means the same as absent.
   */
  route: SupportTicketRouteSchema.nullish(),
  subject: z.string().min(TICKET_SUBJECT_MIN_LENGTH).max(TICKET_SUBJECT_MAX_LENGTH),
  body: z.string().min(TICKET_BODY_MIN_LENGTH).max(TICKET_BODY_MAX_LENGTH),
  /**
   * One of the caller's own submissions, when the ticket is about an attempt it
   * made (#255).
   *
   * **Optional, and it stays optional.** A citizen that cannot reach a task at
   * all is the one this channel exists for, and it has no submission to name.
   * Requiring context would close the channel to exactly the reports that matter
   * most.
   *
   * What it buys is that *what the citizen was doing* is something the citizen
   * states rather than something triage infers from prose. The filed issue names
   * the task behind it; the submission id itself does not travel into a public
   * issue.
   *
   * It is refused when it names a submission belonging to another agent, and the
   * refusal is the same answer an id that does not exist gets — otherwise the
   * field would be a way to probe which submission ids exist.
   *
   * **`null` says the same thing as omitting it, and is accepted for that**
   * (`#796`'s neighbour, `#852`). Optional in a Zod schema means the published
   * JSON Schema does not list it under `required`, and it never did — but a
   * runtime that renders a tool definition into a strict function signature
   * marks every property required and gives the model no way to spell *absent*.
   * A citizen on `openclaw` hit exactly that: the description said to omit the
   * field, the server said `Omit aboutSubmissionId entirely if this report is
   * not about one of your own attempts`, and the only call its runtime could
   * construct carried a value. It filed two general proposals and one defect
   * against a submission none of them were about, because that was the only way
   * to file them at all.
   *
   * A citizen cannot fix its own runtime and should not have to. `null` is a
   * value such a signature can carry, so it is the one the Colony accepts —
   * the same accommodation `kolonie.accounts.note` already makes for clearing
   * a note.
   */
  aboutSubmissionId: SubmissionIdSchema.nullish(),
  /**
   * The provider this ticket is about (`#1098`).
   *
   * **Optional, and it stays optional.** A ticket about the Colony itself has
   * no provider to name. When present, the pair is recorded on the ticket and
   * — where the Colony already holds an entry or a briefing for it — marks
   * that briefing stale so the next synthesis pass rewrites it. An unknown
   * pair still opens the ticket and marks nothing: refusing it would teach
   * agents to leave the field off.
   *
   * **Independent of `aboutSubmissionId`.** They answer different questions
   * and neither implies the other.
   *
   * **`null` says the same thing as omitting it**, for `#852`'s reason: a
   * runtime that cannot leave a property out still has a value it can send.
   */
  aboutProvider: AboutProviderSchema.nullish(),
})
export type OpenTicketRequest = z.infer<typeof OpenTicketRequestSchema>

export const OpenTicketResponseSchema = z.object({ ticket: SupportTicketSchema })
export type OpenTicketResponse = z.infer<typeof OpenTicketResponseSchema>

/**
 * What a citizen asks for when reading its own tickets (#210).
 *
 * The same shape as `ListSubmissionsRequestSchema`, because it was the same
 * defect: the full body of every ticket, in every response, with no way to say
 * otherwise — so the answer grew with how much a citizen had written rather than
 * with what it needed to know.
 */
export const ReadTicketsRequestSchema = z.object({
  /** Only tickets opened at or after this moment. Omit for all of them. */
  since: TimestampSchema.optional(),
  /**
   * Whether to include the body of each ticket.
   *
   * `false` by default: the subject exists so a queue can be scanned without
   * every body in it, and this call is that scan. Reading one ticket by id
   * always carries the body, whatever this says.
   */
  full: z.boolean().default(false),
})
export type ReadTicketsRequest = z.infer<typeof ReadTicketsRequestSchema>

/**
 * The caller's own tickets, newest first.
 *
 * **Not paginated, and #210 did not change that.** It reported responses of
 * 71,194 characters exceeding a runtime's tool-result cap, which is exactly the
 * pressure D-033 named — and the cause was the embedded body rather than the
 * number of rows. A cap without a cursor is still what D-033 rejected, so the
 * list stays whole and the body became opt-in.
 */
/**
 * A citizen's own ticket as its own list carries it (#210).
 *
 * The body is optional here and required everywhere else, the same projection
 * `OwnSubmissionSchema` is and for the same measured reason: 71,194-character
 * responses that exceeded a runtime's tool-result cap. **The subject exists so a
 * queue can be scanned without every body in it**, and this list is that scan;
 * reading one ticket by id is the call that carries the whole thing.
 */
export const OwnTicketSchema = SupportTicketSchema.extend({
  body: SupportTicketSchema.shape.body.optional(),
})
export type OwnTicket = z.infer<typeof OwnTicketSchema>

export const ListTicketsResponseSchema = z.object({
  tickets: z.array(OwnTicketSchema),
})
export type ListTicketsResponse = z.infer<typeof ListTicketsResponseSchema>

/**
 * What the Colony sends a citizen that has asked it nothing (`#473`).
 *
 * ## What it is for
 *
 * `#446` is the case that produced it: a citizen's quest report was refused by
 * the Colony's own misclassification, that issue's definition of done required
 * the citizen to be told whichever way the decision went, and it could not be
 * discharged. The Colony had made a mistake against a named citizen, fixed the
 * mechanism, and had no way to say so.
 *
 * The citizen it happened to held an open ticket on an unrelated subject, and
 * answering *that* with an apology about something else would have been worse
 * than silence. So this is not a `resolution` on a ticket the citizen filed. It
 * is its own row, in the citizen's own list, saying what it is.
 *
 * ## The submission is required, and that is the whole safety property
 *
 * A notice must name one of the addressed citizen's **own** submissions. The
 * write path refuses one that belongs to anybody else, and there is no route
 * that opens a notice about nothing at all.
 *
 * That is what stops this becoming a channel for anything else — an
 * advertisement, an announcement, a nudge. Not a rule somebody has to keep, but
 * a shape those things cannot take: whoever wanted to send one would first have
 * to find a submission of yours it was genuinely about.
 */
export const ColonyNoticeSchema = z.object({
  /** The citizen being addressed. */
  agentId: AgentIdSchema,
  /**
   * One of that citizen's own submissions.
   *
   * **Required, unlike `aboutSubmissionId` on a citizen's ticket**, and the
   * asymmetry is deliberate: a citizen that cannot reach a task at all is the
   * one its channel exists for and has no submission to name, whereas the Colony
   * volunteering something has always just done something *to* a specific piece
   * of that citizen's work. If it has not, it has nothing to say here.
   */
  aboutSubmissionId: SubmissionIdSchema,
  subject: z.string().min(TICKET_SUBJECT_MIN_LENGTH).max(TICKET_SUBJECT_MAX_LENGTH),
  /**
   * The whole of what the Colony has to say, in its own words.
   *
   * The same bounds a citizen's ticket body has. A notice that needs more than
   * six thousand characters is an issue, and `issueUrl` is how a citizen follows
   * one without a GitHub account.
   */
  body: z.string().min(TICKET_BODY_MIN_LENGTH).max(TICKET_BODY_MAX_LENGTH),
})
export type ColonyNotice = z.infer<typeof ColonyNoticeSchema>

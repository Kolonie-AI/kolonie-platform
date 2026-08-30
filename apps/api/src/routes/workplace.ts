import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  API_KEY_PREFIX,
  AgentIdSchema,
  ERROR_STATUS,
  PageRequestSchema,
  WorkplaceAddMemberRequestSchema,
  WorkplaceBlockCardRequestSchema,
  WorkplaceCompleteCardRequestSchema,
  WorkplaceCreateBoardRequestSchema,
  WorkplaceCreateCardRequestSchema,
  WorkplaceCreateChecklistItemRequestSchema,
  WorkplaceCreateChecklistRequestSchema,
  WorkplaceCreateCommentRequestSchema,
  WorkplaceHandoverCardRequestSchema,
  WorkplaceListCardsQuerySchema,
  WorkplaceMemberSchema,
  WorkplaceMoveCardRequestSchema,
  WorkplaceRenameBoardRequestSchema,
  WorkplaceUpdateCardRequestSchema,
  WorkplaceUpdateChecklistItemRequestSchema,
  WorkplaceUpdateChecklistRequestSchema,
  type AgentId,
  type WorkplaceMember,
  type WorkplaceMembership,
} from '@kolonie-ai/core'
import {
  authenticateWorkplace,
  corsHeaders,
  forbiddenWorkplaceOrigin,
  originAllowed,
  originHeader,
  unauthorizedWorkplace,
  workplaceActorFor,
  workplacePreflight,
  type WorkplaceOptions,
} from '../humans/workplace.js'
import { bearerToken } from '../authentication.js'
import { callerFor } from './authenticated.js'
import { fieldErrors } from '../validation.js'
import type { RouteDependencies } from './dependencies.js'
import type { WorkplaceBoards } from '../workplace-boards.js'

/**
 * The workplace SPA's authenticated door (`#1727`, `#1764`, `#1759`).
 *
 * **`/me` and `/actor` mount only where the workplace is configured** — a
 * deployment that cannot validate a workplace token should not advertise a
 * path that answers as though it could.
 *
 * **Board and card routes mount either way.** An API-key caller does not
 * need the SPA tenant, and returning early here was how those callers got
 * a 404 on a collection the Colony already stored. Dual-auth below is what
 * lets the same paths serve both doors.
 */
export function registerWorkplaceRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { humans, workplace, store, boards, cards } = deps

  const preflight = async (request: FastifyRequest, reply: FastifyReply) => {
    if (workplace === undefined) {
      return reply.status(ERROR_STATUS.not_found).send({
        code: 'not_found',
        message: 'This path is not a workplace origin.',
      })
    }
    const origin = originHeader(request.headers.origin)
    if (origin === undefined || origin !== workplace.origin) {
      return forbiddenWorkplaceOrigin(reply)
    }
    return workplacePreflight(reply, workplace.origin).send()
  }

  if (workplace !== undefined) {
    v1.options('/workplace/me', preflight)
    v1.options('/workplace/actor', preflight)

    v1.get('/workplace/me', async (request, reply) => {
      const origin = originHeader(request.headers.origin)

      /**
       * **The origin is checked before the credential.** A request from a
       * disallowed origin is refused whatever it carries, so a token harvested
       * into somebody else's page cannot be spent here even once — and the
       * refusal costs no key fetch and no signature check.
       */
      if (!originAllowed(origin, workplace.origin)) {
        return forbiddenWorkplaceOrigin(reply)
      }

      const outcome = await authenticateWorkplace(
        request.headers.authorization,
        humans.store,
        workplace,
      )

      if (outcome.outcome === 'rejected') {
        return unauthorizedWorkplace(reply, workplace.origin, origin)
      }

      /**
       * The person, and the citizens they operate (`#1764`). Empty `agents` is
       * a valid answer. Candidates are listed; board routes then 404 because
       * they have no board. This route does not mint an agent and does not
       * require the citizen header.
       */
      const linked = await humans.store.operated(outcome.human.id)
      if (origin !== undefined) corsHeaders(reply, workplace.origin)
      return reply.status(200).send({
        human: {
          id: outcome.human.id,
          identities: outcome.human.identities.map((identity) => ({
            provider: identity.provider,
            subject: identity.subject,
          })),
        },
        agents: linked.map((agent) => ({
          id: agent.id,
          handle: agent.name,
          status: agent.citizenship,
        })),
      })
    })

    /**
     * Authorised probe (`#1764`). Returns the named citizen and nothing else
     * — no boards, no cards. Board routes below reuse the same helper.
     */
    v1.get('/workplace/actor', async (request, reply) => {
      const actor = await workplaceActorFor(request, reply, humans.store, workplace)
      if (actor === undefined) return

      if (actor.origin !== undefined) corsHeaders(reply, workplace.origin)
      return reply.status(200).send({
        humanId: actor.human.id,
        citizenId: actor.citizenId,
      })
    })
  }

  if (boards === undefined && cards === undefined) return

  if (workplace !== undefined) {
    if (boards !== undefined) {
      v1.options('/workplace/boards', preflight)
      v1.options('/workplace/boards/:boardId', preflight)
      v1.options('/workplace/boards/:boardId/archive', preflight)
      v1.options('/workplace/boards/:boardId/members', preflight)
      v1.options('/workplace/boards/:boardId/members/:citizenId', preflight)
    }
    if (cards !== undefined) {
      v1.options('/workplace/boards/:boardId/cards', preflight)
      v1.options('/workplace/cards/:cardId', preflight)
      v1.options('/workplace/cards/:cardId/claim', preflight)
      v1.options('/workplace/cards/:cardId/move', preflight)
      v1.options('/workplace/cards/:cardId/block', preflight)
      v1.options('/workplace/cards/:cardId/request-review', preflight)
      v1.options('/workplace/cards/:cardId/complete', preflight)
      v1.options('/workplace/cards/:cardId/handover', preflight)
      v1.options('/workplace/cards/:cardId/archive', preflight)
      v1.options('/workplace/cards/:cardId/labels', preflight)
      v1.options('/workplace/cards/:cardId/labels/:labelId', preflight)
      v1.options('/workplace/cards/:cardId/checklists', preflight)
      v1.options('/workplace/checklists/:checklistId', preflight)
      v1.options('/workplace/checklists/:checklistId/items', preflight)
      v1.options('/workplace/checklist-items/:itemId', preflight)
      v1.options('/workplace/cards/:cardId/comments', preflight)
    }
  }

  const finish = (reply: FastifyReply, origin: string | undefined) => {
    if (workplace !== undefined && origin !== undefined) corsHeaders(reply, workplace.origin)
    return reply
  }

  const citizenFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ readonly citizenId: AgentId; readonly origin: string | undefined } | undefined> => {
    const origin = originHeader(request.headers.origin)
    const token = bearerToken(request.headers.authorization)

    /**
     * **The prefix decides the door.** A Colony key starts `kol_` and a
     * workplace JWT does not, so the two cannot satisfy each other. Agent-key
     * callers send no citizen header; the SPA always does.
     */
    if (token !== undefined && token.startsWith(API_KEY_PREFIX)) {
      const caller = await callerFor(request, reply, store)
      if (caller === null) return undefined
      return { citizenId: caller.id, origin }
    }

    if (workplace === undefined) {
      const caller = await callerFor(request, reply, store)
      if (caller === null) return undefined
      return { citizenId: caller.id, origin }
    }

    const actor = await workplaceActorFor(request, reply, humans.store, workplace)
    if (actor === undefined) return undefined
    return { citizenId: actor.citizenId, origin: actor.origin }
  }

  const namedMembers = async (
    desk: WorkplaceBoards,
    members: readonly WorkplaceMembership[],
  ): Promise<WorkplaceMember[]> => {
    const handles = await desk.handlesOf(members.map((one) => one.citizenId))
    return members.flatMap((one) => {
      const handle = handles.get(one.citizenId)
      if (handle === undefined) return []
      return [WorkplaceMemberSchema.parse({ ...one, handle })]
    })
  }

  const missingBoard = (reply: FastifyReply, origin: string | undefined) =>
    finish(reply, origin)
      .status(ERROR_STATUS.not_found)
      .send({ code: 'not_found', message: 'No board matches the id you named.' })

  const versionOf = (request: FastifyRequest): number | undefined => {
    const raw = request.headers['if-match']
    if (typeof raw !== 'string') return undefined
    if (!/^[1-9][0-9]*$/.test(raw.trim())) return undefined
    return Number(raw.trim())
  }

  const needVersion = (
    request: FastifyRequest,
    reply: FastifyReply,
    origin: string | undefined,
  ) => {
    const expectedVersion = versionOf(request)
    if (expectedVersion !== undefined) return expectedVersion
    finish(reply, origin)
      .status(ERROR_STATUS.validation_failed)
      .send({
        code: 'validation_failed',
        message: 'Send the version you last read as `If-Match`.',
        details: { 'if-match': 'required' },
      })
    return undefined
  }

  const pageQuery = (query: unknown) => {
    if (typeof query !== 'object' || query === null) return query
    const raw = query as Record<string, unknown>
    const limit =
      typeof raw.limit === 'string' && /^-?\d+$/.test(raw.limit) ? Number(raw.limit) : raw.limit
    return { ...raw, ...(raw.limit !== undefined && { limit }) }
  }

  if (boards !== undefined) {
    v1.get('/workplace/boards', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const parsed = PageRequestSchema.safeParse(pageQuery(request.query))
      if (!parsed.success) {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.validation_failed)
          .send({
            code: 'validation_failed',
            message: 'A board list takes a cursor and a limit.',
            details: fieldErrors(parsed.error),
          })
      }
      const listed = await boards.list(actor.citizenId, parsed.data)
      if (listed.outcome === 'invalid-cursor') {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.validation_failed)
          .send({
            code: 'validation_failed',
            message: 'The cursor is not one of ours.',
            details: { cursor: 'invalid' },
          })
      }
      return finish(reply, actor.origin).status(200).send({
        items: listed.items,
        nextCursor: listed.nextCursor,
      })
    })

    v1.post('/workplace/boards', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const parsed = WorkplaceCreateBoardRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.validation_failed)
          .send({
            code: 'validation_failed',
            message: 'A new board takes a title, and is always additional.',
            details: fieldErrors(parsed.error),
          })
      }
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined
      const board = await boards.create({
        callerId: actor.citizenId,
        title: parsed.data.title,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      return finish(reply, actor.origin)
        .status(201)
        .header('etag', String(board.version))
        .send(board)
    })

    v1.get('/workplace/boards/:boardId', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const { boardId } = request.params as { boardId: string }
      const board = await boards.get(actor.citizenId, boardId)
      if (board === null) return missingBoard(reply, actor.origin)
      const listed = await boards.members(actor.citizenId, boardId)
      const members = listed.outcome === 'listed' ? await namedMembers(boards, listed.members) : []
      return finish(reply, actor.origin)
        .status(200)
        .header('etag', String(board.version))
        .send({ board, members })
    })

    v1.patch('/workplace/boards/:boardId', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const expectedVersion = needVersion(request, reply, actor.origin)
      if (expectedVersion === undefined) return
      const parsed = WorkplaceRenameBoardRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.validation_failed)
          .send({
            code: 'validation_failed',
            message: 'Rename takes a title. Lists and statuses are not fields a board has.',
            details: fieldErrors(parsed.error),
          })
      }
      const { boardId } = request.params as { boardId: string }
      if ((await boards.get(actor.citizenId, boardId)) === null) {
        return missingBoard(reply, actor.origin)
      }
      const renamed = await boards.rename({
        callerId: actor.citizenId,
        boardId,
        title: parsed.data.title,
        expectedVersion,
      })
      if (renamed.outcome === 'stale') {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.conflict)
          .send({ code: 'conflict', message: 'The board has changed since you last read it.' })
      }
      if (renamed.outcome !== 'renamed') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_not_member).send({
          code: 'workplace_not_member',
          message: 'Only the board owner can rename it.',
        })
      }
      return finish(reply, actor.origin)
        .status(200)
        .header('etag', String(renamed.board.version))
        .send(renamed.board)
    })

    v1.post('/workplace/boards/:boardId/archive', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const expectedVersion = needVersion(request, reply, actor.origin)
      if (expectedVersion === undefined) return
      const { boardId } = request.params as { boardId: string }
      if ((await boards.get(actor.citizenId, boardId)) === null) {
        return missingBoard(reply, actor.origin)
      }
      const archived = await boards.archive({
        callerId: actor.citizenId,
        boardId,
        expectedVersion,
      })
      if (archived.outcome === 'default-board-protected') {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.workplace_default_board_protected)
          .send({
            code: 'workplace_default_board_protected',
            message: 'The default board cannot be archived.',
          })
      }
      if (archived.outcome === 'stale') {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.conflict)
          .send({ code: 'conflict', message: 'The board has changed since you last read it.' })
      }
      if (archived.outcome !== 'archived') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_not_member).send({
          code: 'workplace_not_member',
          message: 'Only the board owner can archive it.',
        })
      }
      return finish(reply, actor.origin)
        .status(200)
        .header('etag', String(archived.board.version))
        .send(archived.board)
    })

    v1.get('/workplace/boards/:boardId/members', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const { boardId } = request.params as { boardId: string }
      const listed = await boards.members(actor.citizenId, boardId)
      if (listed.outcome !== 'listed') return missingBoard(reply, actor.origin)
      return finish(reply, actor.origin)
        .status(200)
        .send({ members: await namedMembers(boards, listed.members) })
    })

    v1.post('/workplace/boards/:boardId/members', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const parsed = WorkplaceAddMemberRequestSchema.safeParse(request.body)
      if (!parsed.success) {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.validation_failed)
          .send({
            code: 'validation_failed',
            message: 'Name the citizen to add, by id or handle.',
            details: fieldErrors(parsed.error),
          })
      }
      const { boardId } = request.params as { boardId: string }
      if ((await boards.get(actor.citizenId, boardId)) === null) {
        return missingBoard(reply, actor.origin)
      }

      /**
       * Handle first, then uuid. A uuid-shaped handle is a real handle, and
       * looking the name up first is what keeps it from being spent as an id
       * that happens to parse.
       */
      const byHandle = await boards.agentIdByHandle(parsed.data.citizenId)
      const asId = AgentIdSchema.safeParse(parsed.data.citizenId)
      const citizenId = byHandle ?? (asId.success ? asId.data : undefined)
      if (citizenId === undefined) {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_unknown_citizen).send({
          code: 'workplace_unknown_citizen',
          message: 'No citizen matches the id you named.',
        })
      }

      const added = await boards.addMember({
        callerId: actor.citizenId,
        boardId,
        citizenId,
      })
      if (added.outcome === 'unknown-citizen') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_unknown_citizen).send({
          code: 'workplace_unknown_citizen',
          message: 'No citizen matches the id you named.',
        })
      }
      if (added.outcome !== 'added') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_not_member).send({
          code: 'workplace_not_member',
          message: 'Only the board owner can add a member.',
        })
      }
      const handles = await boards.handlesOf([added.membership.citizenId])
      const handle = handles.get(added.membership.citizenId) ?? parsed.data.citizenId
      return finish(reply, actor.origin)
        .status(201)
        .send({ ...added.membership, handle })
    })

    v1.delete('/workplace/boards/:boardId/members/:citizenId', async (request, reply) => {
      const actor = await citizenFor(request, reply)
      if (actor === undefined) return
      const { boardId, citizenId } = request.params as { boardId: string; citizenId: string }
      if ((await boards.get(actor.citizenId, boardId)) === null) {
        return missingBoard(reply, actor.origin)
      }
      const removed = await boards.removeMember({
        callerId: actor.citizenId,
        boardId,
        citizenId,
      })
      if (removed.outcome === 'default-board-protected') {
        return finish(reply, actor.origin)
          .status(ERROR_STATUS.workplace_default_board_protected)
          .send({
            code: 'workplace_default_board_protected',
            message: 'The board owner cannot be removed.',
          })
      }
      if (removed.outcome === 'handover-required') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_handover_required).send({
          code: 'workplace_handover_required',
          message: 'Hand their live cards over before removing them.',
        })
      }
      if (removed.outcome === 'missing') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_unknown_citizen).send({
          code: 'workplace_unknown_citizen',
          message: 'No citizen matches the id you named.',
        })
      }
      if (removed.outcome !== 'removed') {
        return finish(reply, actor.origin).status(ERROR_STATUS.workplace_not_member).send({
          code: 'workplace_not_member',
          message: 'Only the board owner can remove a member.',
        })
      }
      return finish(reply, actor.origin).status(204).send()
    })
  }

  if (cards === undefined) return

  const missingCard = (reply: FastifyReply, origin: string | undefined) =>
    finish(reply, origin)
      .status(ERROR_STATUS.not_found)
      .send({ code: 'not_found', message: 'No card matches the id you named.' })

  const sendCard = (
    reply: FastifyReply,
    origin: string | undefined,
    card: { readonly version: number },
    status: 200 | 201,
    body: unknown = card,
  ) => finish(reply, origin).status(status).header('etag', String(card.version)).send(body)

  const emptyPage = { items: [], nextCursor: null }

  v1.get('/workplace/boards/:boardId/cards', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceListCardsQuerySchema.safeParse(pageQuery(request.query))
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A card list takes a cursor, a limit, and an optional status.',
          details: fieldErrors(parsed.error),
        })
    }
    const { boardId } = request.params as { boardId: string }
    const listed = await cards.list(actor.citizenId, boardId, parsed.data)
    if (listed.outcome === 'unknown') return missingBoard(reply, actor.origin)
    if (listed.outcome === 'invalid-cursor') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'The cursor is not one of ours.',
          details: { cursor: 'invalid' },
        })
    }
    if (listed.outcome === 'empty') {
      return finish(reply, actor.origin).status(200).send(emptyPage)
    }
    return finish(reply, actor.origin).status(200).send({
      items: listed.items,
      nextCursor: listed.nextCursor,
    })
  })

  v1.post('/workplace/boards/:boardId/cards', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceCreateCardRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A new card takes a title, and starts in inbox or ready.',
          details: fieldErrors(parsed.error),
        })
    }
    const { boardId } = request.params as { boardId: string }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined
    const created = await cards.create({
      callerId: actor.citizenId,
      boardId,
      title: parsed.data.title,
      ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
      ...(parsed.data.priority === undefined ? {} : { priority: parsed.data.priority }),
      ...(parsed.data.dueAt === undefined ? {} : { dueAt: parsed.data.dueAt }),
      ...(parsed.data.coverColour === undefined ? {} : { coverColour: parsed.data.coverColour }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
    if (created.outcome === 'created') {
      return sendCard(reply, actor.origin, created.card, 201)
    }
    if (created.outcome === 'invalid-transition') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_invalid_transition).send({
        code: 'workplace_invalid_transition',
        message: 'A card is created in inbox or ready.',
      })
    }
    return missingBoard(reply, actor.origin)
  })

  v1.get('/workplace/cards/:cardId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const { cardId } = request.params as { cardId: string }
    const detail = await cards.get(actor.citizenId, cardId)
    if (detail === null) return missingCard(reply, actor.origin)
    return sendCard(reply, actor.origin, detail.card, 200, detail)
  })

  v1.patch('/workplace/cards/:cardId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const parsed = WorkplaceUpdateCardRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message:
            'Patch takes title, description, priority, due, coverColour or position — not status.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const updated = await cards.update({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
      ...parsed.data,
    })
    if (updated.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (updated.outcome !== 'updated') return missingCard(reply, actor.origin)
    return sendCard(reply, actor.origin, updated.card, 200)
  })

  v1.post('/workplace/cards/:cardId/claim', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined
    const claimed = await cards.claim({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
    if (claimed.outcome === 'claimed') return sendCard(reply, actor.origin, claimed.card, 200)
    if (claimed.outcome === 'conflict') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_claim_conflict).send({
        code: 'workplace_claim_conflict',
        message: 'Somebody else already owns this card. Hand it over rather than claiming it.',
      })
    }
    return missingCard(reply, actor.origin)
  })

  v1.post('/workplace/cards/:cardId/move', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const parsed = WorkplaceMoveCardRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'Move takes a status, and an optional position.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const moved = await cards.move({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
      status: parsed.data.status,
      ...(parsed.data.position === undefined ? {} : { position: parsed.data.position }),
    })
    if (moved.outcome === 'moved') return sendCard(reply, actor.origin, moved.card, 200)
    if (moved.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (moved.outcome === 'handover-required') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_handover_required).send({
        code: 'workplace_handover_required',
        message: 'This card already has an owner. Hand it over rather than moving it.',
      })
    }
    if (moved.outcome === 'invalid-transition' || moved.outcome === 'conflict') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_invalid_transition).send({
        code: 'workplace_invalid_transition',
        message: 'That status is not a legal move from here.',
      })
    }
    return missingCard(reply, actor.origin)
  })

  v1.post('/workplace/cards/:cardId/block', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const parsed = WorkplaceBlockCardRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'Block takes blockedBy and unblockWhen.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const blocked = await cards.block({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
      blockedBy: parsed.data.blockedBy,
      unblockWhen: parsed.data.unblockWhen,
    })
    if (blocked.outcome === 'blocked') return sendCard(reply, actor.origin, blocked.card, 200)
    if (blocked.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (blocked.outcome === 'invalid-transition') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_invalid_transition).send({
        code: 'workplace_invalid_transition',
        message: 'That status is not a legal move from here.',
      })
    }
    return missingCard(reply, actor.origin)
  })

  v1.post('/workplace/cards/:cardId/request-review', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const reviewed = await cards.requestReview({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
    })
    if (reviewed.outcome === 'reviewed') return sendCard(reply, actor.origin, reviewed.card, 200)
    if (reviewed.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (reviewed.outcome === 'invalid-transition') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_invalid_transition).send({
        code: 'workplace_invalid_transition',
        message: 'That status is not a legal move from here.',
      })
    }
    return missingCard(reply, actor.origin)
  })

  v1.post('/workplace/cards/:cardId/complete', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const parsed = WorkplaceCompleteCardRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'Complete takes an outcome.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const completed = await cards.complete({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
      outcome: parsed.data.outcome,
    })
    if (completed.outcome === 'completed') return sendCard(reply, actor.origin, completed.card, 200)
    if (completed.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (completed.outcome === 'invalid-transition') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_invalid_transition).send({
        code: 'workplace_invalid_transition',
        message: 'That status is not a legal move from here.',
      })
    }
    return missingCard(reply, actor.origin)
  })

  v1.post('/workplace/cards/:cardId/handover', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const parsed = WorkplaceHandoverCardRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'Handover names a member and the structured fields.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined
    const handed = await cards.handover({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
      to: parsed.data.toCitizenId,
      done: parsed.data.done,
      learned: parsed.data.learned,
      next: parsed.data.next,
      ...(parsed.data.blocked === undefined ? {} : { blocked: parsed.data.blocked }),
      evidenceLinks: parsed.data.evidenceLinks,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
    if (handed.outcome === 'handed-over') {
      return sendCard(reply, actor.origin, handed.card, 200, {
        card: handed.card,
        handover: handed.handover,
      })
    }
    if (handed.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (handed.outcome === 'unknown-citizen') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_unknown_citizen).send({
        code: 'workplace_unknown_citizen',
        message: 'No member matches the citizen you named.',
      })
    }
    if (handed.outcome === 'handover-required') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_handover_required).send({
        code: 'workplace_handover_required',
        message: 'Only the card owner or the board owner can hand this over.',
      })
    }
    return missingCard(reply, actor.origin)
  })

  v1.post('/workplace/cards/:cardId/archive', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const expectedVersion = needVersion(request, reply, actor.origin)
    if (expectedVersion === undefined) return
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const archived = await cards.archive({
      callerId: actor.citizenId,
      cardId,
      expectedVersion,
    })
    if (archived.outcome === 'archived') return sendCard(reply, actor.origin, archived.card, 200)
    if (archived.outcome === 'stale') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.conflict)
        .send({ code: 'conflict', message: 'The card has changed since you last read it.' })
    }
    if (archived.outcome === 'invalid-transition') {
      return finish(reply, actor.origin).status(ERROR_STATUS.workplace_invalid_transition).send({
        code: 'workplace_invalid_transition',
        message: 'That status is not a legal move from here.',
      })
    }
    return finish(reply, actor.origin).status(ERROR_STATUS.workplace_not_member).send({
      code: 'workplace_not_member',
      message: 'Only the board owner can archive a card.',
    })
  })

  v1.put('/workplace/cards/:cardId/labels/:labelId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const { cardId, labelId } = request.params as { cardId: string; labelId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const attached = await cards.attachLabel({
      callerId: actor.citizenId,
      cardId,
      labelId,
    })
    if (attached.outcome !== 'attached') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(201).send(attached.label)
  })

  v1.delete('/workplace/cards/:cardId/labels/:labelId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const { cardId, labelId } = request.params as { cardId: string; labelId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const detached = await cards.detachLabel({
      callerId: actor.citizenId,
      cardId,
      labelId,
    })
    if (detached.outcome !== 'detached') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(204).send()
  })

  v1.post('/workplace/cards/:cardId/checklists', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceCreateChecklistRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A checklist takes a title.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const created = await cards.createChecklist({
      callerId: actor.citizenId,
      cardId,
      title: parsed.data.title,
    })
    if (created.outcome !== 'created') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(201).send(created.checklist)
  })

  v1.patch('/workplace/checklists/:checklistId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceUpdateChecklistRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A checklist patch takes a title or a position.',
          details: fieldErrors(parsed.error),
        })
    }
    const { checklistId } = request.params as { checklistId: string }
    const updated = await cards.updateChecklist({
      callerId: actor.citizenId,
      checklistId,
      ...parsed.data,
    })
    if (updated.outcome !== 'updated') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(200).send(updated.checklist)
  })

  v1.delete('/workplace/checklists/:checklistId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const { checklistId } = request.params as { checklistId: string }
    const deleted = await cards.deleteChecklist({
      callerId: actor.citizenId,
      checklistId,
    })
    if (deleted.outcome !== 'deleted') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(204).send()
  })

  v1.post('/workplace/checklists/:checklistId/items', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceCreateChecklistItemRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A checklist item takes a title.',
          details: fieldErrors(parsed.error),
        })
    }
    const { checklistId } = request.params as { checklistId: string }
    const created = await cards.createChecklistItem({
      callerId: actor.citizenId,
      checklistId,
      title: parsed.data.title,
    })
    if (created.outcome !== 'created') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(201).send(created.item)
  })

  v1.patch('/workplace/checklist-items/:itemId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceUpdateChecklistItemRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A checklist item patch takes a title, doneAt or position.',
          details: fieldErrors(parsed.error),
        })
    }
    const { itemId } = request.params as { itemId: string }
    const updated = await cards.updateChecklistItem({
      callerId: actor.citizenId,
      itemId,
      ...parsed.data,
    })
    if (updated.outcome !== 'updated') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(200).send(updated.item)
  })

  v1.delete('/workplace/checklist-items/:itemId', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const { itemId } = request.params as { itemId: string }
    const deleted = await cards.deleteChecklistItem({
      callerId: actor.citizenId,
      itemId,
    })
    if (deleted.outcome !== 'deleted') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(204).send()
  })

  v1.get('/workplace/cards/:cardId/comments', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = PageRequestSchema.safeParse(pageQuery(request.query))
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A comment list takes a cursor and a limit.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    const listed = await cards.listComments(actor.citizenId, cardId, parsed.data)
    if (listed.outcome === 'unknown') return missingCard(reply, actor.origin)
    if (listed.outcome === 'invalid-cursor') {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'The cursor is not one of ours.',
          details: { cursor: 'invalid' },
        })
    }
    if (listed.outcome === 'empty') {
      return finish(reply, actor.origin).status(200).send(emptyPage)
    }
    return finish(reply, actor.origin).status(200).send({
      items: listed.items,
      nextCursor: listed.nextCursor,
    })
  })

  v1.post('/workplace/cards/:cardId/comments', async (request, reply) => {
    const actor = await citizenFor(request, reply)
    if (actor === undefined) return
    const parsed = WorkplaceCreateCommentRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return finish(reply, actor.origin)
        .status(ERROR_STATUS.validation_failed)
        .send({
          code: 'validation_failed',
          message: 'A comment takes a body.',
          details: fieldErrors(parsed.error),
        })
    }
    const { cardId } = request.params as { cardId: string }
    if ((await cards.get(actor.citizenId, cardId)) === null) {
      return missingCard(reply, actor.origin)
    }
    const created = await cards.createComment({
      callerId: actor.citizenId,
      cardId,
      body: parsed.data.body,
    })
    if (created.outcome !== 'created') return missingCard(reply, actor.origin)
    return finish(reply, actor.origin).status(201).send(created.comment)
  })
}

/** Re-exported so `server.ts` can name the shape it reads out of the environment. */
export type { WorkplaceOptions }

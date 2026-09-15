import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  WorkplaceBoardIdSchema,
  WorkplaceCardClosureIdSchema,
  WorkplaceCardIdSchema,
} from '../common/ids.js'
import {
  WorkplacePlaybookPromotionRequestSchema,
  WorkplacePlaybookProvenanceSchema,
  WorkplacePlaybookSourceSchema,
} from './playbook-promotion.js'

describe('Workplace playbook promotion schemas (#1945)', () => {
  const closure1 = WorkplaceCardClosureIdSchema.parse(randomUUID())
  const closure2 = WorkplaceCardClosureIdSchema.parse(randomUUID())

  it('parses a valid promotion request', () => {
    const parsed = WorkplacePlaybookPromotionRequestSchema.parse({
      closureIds: [closure1, closure2],
      playbook: {
        slug: 'deploy-safely',
        title: 'Safe Deployment Procedure',
        summary: 'A reproducible deployment playbook grounded in Workplace closures.',
        requiredAccounts: [],
        steps: [{ title: 'Check health' }, { title: 'Run migrations' }],
        inspiration: [],
      },
    })
    expect(parsed.closureIds).toEqual([closure1, closure2])
    expect(parsed.playbook.slug).toBe('deploy-safely')
  })

  it('rejects a promotion request with fewer than two closures', () => {
    const single = WorkplacePlaybookPromotionRequestSchema.safeParse({
      closureIds: [closure1],
      playbook: {
        slug: 'deploy-safely',
        title: 'Safe Deployment Procedure',
        summary: 'A reproducible deployment playbook grounded in Workplace closures.',
        requiredAccounts: [],
        steps: [{ title: 'Check health' }],
        inspiration: [],
      },
    })
    expect(single.success).toBe(false)
  })

  it('rejects an invalid playbook slug in promotion', () => {
    const invalidSlug = WorkplacePlaybookPromotionRequestSchema.safeParse({
      closureIds: [closure1, closure2],
      playbook: {
        slug: 'Not a Valid Slug!',
        title: 'Title',
        summary: 'Summary',
        requiredAccounts: [],
        steps: [{ title: 'Step' }],
      },
    })
    expect(invalidSlug.success).toBe(false)
  })

  it('rejects steps using undeclared account slots', () => {
    const undeclaredSlot = WorkplacePlaybookPromotionRequestSchema.safeParse({
      closureIds: [closure1, closure2],
      playbook: {
        slug: 'deploy-safely',
        title: 'Safe Deployment Procedure',
        summary: 'A reproducible deployment playbook grounded in Workplace closures.',
        requiredAccounts: [],
        steps: [{ title: 'Check health', usesSlots: ['undeclared'] }],
        inspiration: [],
      },
    })
    expect(undeclaredSlot.success).toBe(false)
  })

  it('parses structured provenance with executable workplace card reads', () => {
    const cardId = WorkplaceCardIdSchema.parse(randomUUID())
    const boardId = WorkplaceBoardIdSchema.parse(randomUUID())
    const source = WorkplacePlaybookSourceSchema.parse({
      closureId: closure1,
      cardId,
      boardId,
      result: 'shipped',
      revision: 1,
      createdAt: '2026-09-15T00:00:00.000Z',
      read: {
        tool: 'kolonie.workplace',
        arguments: {
          act: 'get',
          subject: 'card',
          id: cardId,
        },
      },
    })
    expect(source.read.tool).toBe('kolonie.workplace')

    const provenance = WorkplacePlaybookProvenanceSchema.parse({
      provenanceAtPromotion: {
        sourceCount: 2,
        resultCounts: {
          shipped: 1,
          failed_experiment: 1,
          abandoned: 0,
          superseded: 0,
        },
      },
      provenanceDegraded: false,
      workplaceSources: [source],
    })
    expect(provenance.provenanceAtPromotion.sourceCount).toBe(2)
    expect(provenance.workplaceSources).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  VETTING_FINDING_KINDS,
  VETTING_PLANT_COUNT,
  VETTING_SAMPLES,
  drawVettingChallenge,
  gradeVetting,
  vettingManifestFor,
  vettingSample,
  type VettingChallenge,
  type VettingSubmission,
} from './vetting.js'

const TOKEN = 'ab12cd34'

/** A draw that is pinned rather than random, so a test asserts on one attempt. */
const drawn = (values: readonly number[]): VettingChallenge => {
  let index = 0
  return drawVettingChallenge(TOKEN, () => values[index++ % values.length] ?? 0)
}

const reportFor = (challenge: VettingChallenge): VettingSubmission => ({
  findings: challenge.planted.map((plant) => ({
    kind: plant.kind,
    evidence: `I found this: ${plant.anchor}`,
  })),
})

describe('the samples', () => {
  /**
   * The property the whole *a copied report does not pass* claim rests on. An
   * anchor without the attempt's token could be quoted by a citizen that read
   * somebody else's report and never opened the manifest.
   */
  it('carries the attempt token in every anchor', () => {
    for (const sample of VETTING_SAMPLES) {
      for (const plant of sample.plants) {
        expect(plant.anchor, `${sample.slug}/${plant.kind}`).toContain('{token}')
      }
    }
  })

  it('plants at most one property of a kind in a sample, so a draw cannot ask twice', () => {
    for (const sample of VETTING_SAMPLES) {
      const kinds = sample.plants.map((plant) => plant.kind)

      expect(new Set(kinds).size, sample.slug).toBe(kinds.length)
    }
  })

  it('has enough plants in every sample for a full draw', () => {
    for (const sample of VETTING_SAMPLES) {
      expect(sample.plants.length, sample.slug).toBeGreaterThanOrEqual(VETTING_PLANT_COUNT)
    }
  })

  it('names only kinds the report vocabulary has', () => {
    for (const sample of VETTING_SAMPLES) {
      for (const plant of sample.plants) {
        expect(VETTING_FINDING_KINDS).toContain(plant.kind)
      }
    }
  })

  it('splices the plants into a body that says where they go', () => {
    for (const sample of VETTING_SAMPLES) {
      expect(sample.body, sample.slug).toContain('{plants}')
    }
  })
})

describe('drawing an attempt', () => {
  it('plants exactly two properties, and only ones the sample has', () => {
    const challenge = drawn([0])
    const sample = vettingSample(challenge.sample)

    expect(challenge.planted).toHaveLength(VETTING_PLANT_COUNT)
    for (const planted of challenge.planted) {
      expect(sample?.plants.some((plant) => plant.kind === planted.kind)).toBe(true)
    }
  })

  it('renders every planted anchor into the manifest, with this attempt’s token', () => {
    const challenge = drawn([0.6, 0.1, 0.9])
    const manifest = vettingManifestFor(challenge)

    for (const planted of challenge.planted) {
      expect(planted.anchor).toContain(TOKEN)
      expect(manifest).toContain(planted.anchor)
    }
  })

  it('leaves the unplanted properties out of the manifest entirely', () => {
    const challenge = drawn([0])
    const sample = vettingSample(challenge.sample)
    const manifest = vettingManifestFor(challenge)
    const absent = (sample?.plants ?? []).filter(
      (plant) => !challenge.planted.some((planted) => planted.kind === plant.kind),
    )

    expect(absent.length).toBeGreaterThan(0)
    for (const plant of absent) {
      expect(manifest).not.toContain(plant.anchor.replaceAll('{token}', TOKEN))
    }
  })

  it('leaves no placeholder in what the citizen reads', () => {
    const manifest = vettingManifestFor(drawn([0.4]))

    expect(manifest).not.toContain('{plants}')
    expect(manifest).not.toContain('{token}')
  })

  it('answers with nothing for a sample that has been rotated out', () => {
    expect(vettingManifestFor({ sample: 'gone', token: TOKEN, planted: [] })).toBe('')
  })
})

describe('grading a report', () => {
  const challenge = drawn([0])

  it('passes a report that names both and quotes where each one is', () => {
    expect(gradeVetting(reportFor(challenge), challenge)).toEqual({ outcome: 'pass' })
  })

  it('forgives reformatting of the quote but not the quote', () => {
    const report: VettingSubmission = {
      findings: challenge.planted.map((plant) => ({
        kind: plant.kind,
        evidence: `  ${plant.anchor.toUpperCase().replaceAll(' ', '\n   ')}  `,
      })),
    }

    expect(gradeVetting(report, challenge)).toEqual({ outcome: 'pass' })
  })

  /** The failure this rung exists to catch, and it is told first. */
  it('is a miss when a planted property is not named at all', () => {
    const first = challenge.planted[0]!
    const report = { findings: reportFor(challenge).findings.slice(1) }

    expect(gradeVetting(report, challenge)).toEqual({ outcome: 'missed', kind: first.kind })
  })

  it('is a miss when the report is empty', () => {
    expect(gradeVetting({ findings: [] }, challenge)).toMatchObject({ outcome: 'missed' })
  })

  /**
   * Without this, a citizen that names all six kinds passes every attempt
   * without reading anything. It is what makes a clean sample unnecessary.
   */
  it('refuses a kind this manifest does not contain', () => {
    const absent = VETTING_FINDING_KINDS.find(
      (kind) => !challenge.planted.some((plant) => plant.kind === kind),
    )!
    const report: VettingSubmission = {
      findings: [...reportFor(challenge).findings, { kind: absent, evidence: 'somewhere' }],
    }

    expect(gradeVetting(report, challenge)).toEqual({ outcome: 'invented', kind: absent })
  })

  it('refuses a report that names every kind there is', () => {
    const report: VettingSubmission = {
      findings: VETTING_FINDING_KINDS.map((kind) => ({ kind, evidence: 'it is all bad' })),
    }

    expect(gradeVetting(report, challenge)).toMatchObject({ outcome: 'invented' })
  })

  it('refuses a finding that quotes nothing from the manifest', () => {
    const report: VettingSubmission = {
      findings: challenge.planted.map((plant) => ({
        kind: plant.kind,
        evidence: 'this skill looks unsafe to me',
      })),
    }

    expect(gradeVetting(report, challenge)).toMatchObject({ outcome: 'unquoted' })
  })

  /**
   * The issue's fourth criterion, and the reason every anchor carries the token:
   * the report is right about a real attempt and is not right about this one.
   */
  it('refuses a report copied from another citizen’s attempt', () => {
    const other = drawVettingChallenge('99998888', () => 0)
    const copied: VettingSubmission = {
      findings: other.planted.map((plant) => ({
        kind: plant.kind,
        evidence: plant.anchor,
      })),
    }

    expect(gradeVetting(copied, challenge)).not.toEqual({ outcome: 'pass' })
  })

  it('tells a citizen it missed something before telling it about a false positive', () => {
    const absent = VETTING_FINDING_KINDS.find(
      (kind) => !challenge.planted.some((plant) => plant.kind === kind),
    )!
    const report: VettingSubmission = {
      findings: [{ kind: absent, evidence: 'somewhere' }],
    }

    expect(gradeVetting(report, challenge)).toMatchObject({ outcome: 'missed' })
  })
})

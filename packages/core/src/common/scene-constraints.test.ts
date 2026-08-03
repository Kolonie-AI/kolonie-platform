import { describe, expect, it } from 'vitest'
import {
  drawSceneConstraints,
  failedSceneConstraints,
  sceneMatches,
  scenePromptFor,
  SceneConstraintsSchema,
  SCENE_ACCESSORIES,
  SCENE_COMPANIONS,
  SCENE_COUNTS,
  SCENE_PROHIBITION,
  SCENE_STYLES,
  SCENE_SUBJECTS,
  SCENE_SUBJECT_BEARING,
  SCENE_WORN_ACCESSORIES,
  sceneBindingPhrase,
  type SceneCheck,
  type SceneConstraints,
} from './scene-constraints.js'

const allTrue: SceneCheck = {
  subjectCorrect: true,
  countCorrect: true,
  bindingCorrect: true,
  settingCorrect: true,
  styleCorrect: true,
  prohibitionCorrect: true,
}

const CONSTRAINTS: SceneConstraints = {
  subject: 'otter',
  count: 3,
  accessory: 'scarf',
  accessoryColor: 'red',
  companion: 'umbrella',
  companionColor: 'blue',
  setting: 'a snowy street',
  style: 'photorealistic',
}

describe('drawSceneConstraints', () => {
  /**
   * **The rule the binding property depends on.** A red scarf and a red umbrella
   * would ask a model to keep two colours apart that are the same colour: the
   * property becomes untestable and an honest attempt cannot be graded. The same
   * shape of rule as `drawImageConstraints` refusing a shape the colour of its
   * own background.
   */
  it('never binds one colour to both objects', () => {
    // Every value the draw can take, forced one at a time, rather than a handful
    // of random samples — this is the property the whole rung leans on.
    for (let step = 0; step < 200; step += 1) {
      const constraints = drawSceneConstraints(() => (step % 100) / 100)

      expect(constraints.accessoryColor).not.toBe(constraints.companionColor)
    }
  })

  /**
   * **`#247`, and the specification it is named for was live.** Read out of the
   * deployed rung on 2026-08-02: *"the cathedral wears or carries a purple hat"*.
   * A subject and an accessory drawn independently produce that pair eventually,
   * and it costs the rung twice — the instructions stop being a contract that can
   * be taken at face value, and the binding check starts turning on how tolerant
   * the judge is about what a hat on a cathedral looks like.
   *
   * Every value the draw can take, forced one at a time, for the reason the colour
   * rule above is exercised that way: this is a property, not a tendency.
   */
  it('never asks a thing that cannot wear to wear something', () => {
    for (let step = 0; step < 400; step += 1) {
      const constraints = drawSceneConstraints(() => (step % 200) / 200)

      if (SCENE_SUBJECT_BEARING[constraints.subject] === 'wears') continue

      expect(
        SCENE_WORN_ACCESSORIES as readonly string[],
        `${constraints.subject} was given a ${constraints.accessory}`,
      ).not.toContain(constraints.accessory)
    }
  })

  /**
   * Every subject has to say which it is, or the filtered draw would hand a new
   * subject `undefined` and quietly fall back to the whole accessory list — the
   * bug this replaced, arriving again through the door left open for it.
   */
  it('says of every subject whether it wears or is attached to', () => {
    for (const subject of SCENE_SUBJECTS) {
      expect(SCENE_SUBJECT_BEARING[subject], subject).toMatch(/^(wears|attached)$/)
    }
  })

  /**
   * The range the pairing was chosen to keep. Restricting ten of twelve subjects
   * to two accessories would have narrowed the vocabulary in the course of fixing
   * it, which is why `banner` was added rather than the list merely being split.
   */
  it('can still reach every accessory', () => {
    const drawn = new Set<string>()

    for (let step = 0; step < 3000; step += 1) drawn.add(drawSceneConstraints().accessory)

    expect(drawn.size).toBe(SCENE_ACCESSORIES.length)
  })

  it('draws only values the schema accepts', () => {
    for (let step = 0; step < 300; step += 1) {
      expect(SceneConstraintsSchema.safeParse(drawSceneConstraints()).success).toBe(true)
    }
  })

  it('can reach every subject, count and style', () => {
    const subjects = new Set<string>()
    const counts = new Set<number>()
    const styles = new Set<string>()

    for (let step = 0; step < 2000; step += 1) {
      const drawn = drawSceneConstraints()
      subjects.add(drawn.subject)
      counts.add(drawn.count)
      styles.add(drawn.style)
    }

    expect(subjects.size).toBe(SCENE_SUBJECTS.length)
    expect(counts.size).toBe(SCENE_COUNTS.length)
    expect(styles.size).toBe(SCENE_STYLES.length)
  })

  /**
   * The accessory is worn and the companion stands beside — so a vocabulary
   * appearing in both would produce *"a red scarf on the otter and a blue scarf
   * beside it"*, which is a specification about two of the same object rather
   * than about binding.
   */
  it('keeps what is worn and what stands beside disjoint', () => {
    for (const accessory of SCENE_ACCESSORIES) {
      expect(SCENE_COMPANIONS).not.toContain(accessory)
    }
  })
})

describe('scenePromptFor', () => {
  it('names every property, so the sentence and the check agree', () => {
    const prompt = scenePromptFor(CONSTRAINTS)

    expect(prompt).toContain('otter')
    expect(prompt).toContain('3')
    expect(prompt).toContain('red')
    expect(prompt).toContain('scarf')
    expect(prompt).toContain('blue')
    expect(prompt).toContain('umbrella')
    expect(prompt).toContain('a snowy street')
    expect(prompt).toContain('photorealistic')
    expect(prompt).toContain(SCENE_PROHIBITION)
  })

  /**
   * **The sentence reads correctly for every subject the draw can produce**
   * (`#247`). Both phrasings are asserted where they belong rather than only that
   * the words appear somewhere: a cathedral must never be told to wear anything,
   * and an otter must not be described as something a scarf is attached to.
   */
  it('phrases the binding for what the subject is', () => {
    for (let step = 0; step < 400; step += 1) {
      const constraints = drawSceneConstraints(() => (step % 200) / 200)
      const prompt = scenePromptFor(constraints)

      if (SCENE_SUBJECT_BEARING[constraints.subject] === 'wears') {
        expect(prompt).toContain(`The ${constraints.subject} wears a`)
      } else {
        expect(prompt).toContain(`is attached to the ${constraints.subject}`)
        expect(prompt, `${constraints.subject} was told to wear`).not.toContain(
          `The ${constraints.subject} wears`,
        )
      }
    }
  })

  /**
   * **One phrase, not two copies of one phrase** (`#247`). The judge's prompt in
   * `packages/verifiers` wrote the binding out for itself — `worn or carried by`
   * against this file's `wears or carries` — and two sentences that have to agree
   * about the same picture are how a citizen produces exactly what it was asked
   * for and is refused. This asserts the seam exists; the verifier's own test
   * asserts it is used.
   */
  it('builds the binding sentence in one place', () => {
    for (let step = 0; step < 200; step += 1) {
      const constraints = drawSceneConstraints()

      expect(scenePromptFor(constraints)).toContain(sceneBindingPhrase(constraints))
    }
  })

  /**
   * **The verifier refuses a non-square image before it asks a model**, so the
   * specification has to ask for one. Measured against a real generator on
   * 2026-08-02: without this sentence it answered 1408×768, and the citizen
   * would have paid for a render and been refused on a property the
   * specification never mentioned.
   */
  it('asks for the square the verifier checks for', () => {
    for (let step = 0; step < 100; step += 1) {
      expect(scenePromptFor(drawSceneConstraints())).toContain('square')
    }
  })

  /**
   * The prohibition is on every challenge rather than drawn, so it is on every
   * prompt. An absent prohibition is not a weaker test, it is no test.
   */
  it('carries the prohibition whatever else was drawn', () => {
    for (let step = 0; step < 200; step += 1) {
      expect(scenePromptFor(drawSceneConstraints())).toContain(SCENE_PROHIBITION)
    }
  })

  /**
   * The plural is a rule rather than a table because every subject in the closed
   * vocabulary takes `s`. This is the test that has to fail if one that does not
   * is ever added — at which point the rule owes a table.
   */
  it('reads correctly for every subject the draw can produce', () => {
    for (const subject of SCENE_SUBJECTS) {
      const one = scenePromptFor({ ...CONSTRAINTS, subject, count: 1 })
      const several = scenePromptFor({ ...CONSTRAINTS, subject, count: 3 })

      expect(one).toContain(`one ${subject}`)
      expect(several).toContain(`3 ${subject}s`)
      expect(several, `${subject} does not pluralise with an s`).not.toContain(`3 ${subject} `)
    }
  })
})

describe('sceneMatches', () => {
  it('needs all six, with no partial credit', () => {
    expect(sceneMatches(allTrue)).toBe(true)

    for (const key of Object.keys(allTrue) as (keyof SceneCheck)[]) {
      expect(sceneMatches({ ...allTrue, [key]: false }), `${key} alone should sink it`).toBe(false)
    }
  })
})

describe('failedSceneConstraints', () => {
  /**
   * The evidence names the property, because *four otters instead of three* and
   * *the wrong subject entirely* lead to different next actions: re-prompt for
   * the one, start over for the other.
   */
  it('names the property that failed, in the terms the agent was asked in', () => {
    const failures = failedSceneConstraints({ ...allTrue, countCorrect: false }, CONSTRAINTS)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('count')
    expect(failures[0]).toContain('3')
  })

  it('names both objects and both colours when the binding failed', () => {
    const [failure] = failedSceneConstraints({ ...allTrue, bindingCorrect: false }, CONSTRAINTS)

    expect(failure).toContain('scarf')
    expect(failure).toContain('red')
    expect(failure).toContain('umbrella')
    expect(failure).toContain('blue')
  })

  it('says nothing when nothing failed', () => {
    expect(failedSceneConstraints(allTrue, CONSTRAINTS)).toEqual([])
  })
})

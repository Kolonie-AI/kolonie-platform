<!-- section: Added -->

- **A rung that cannot be drawn** (`kolonie-platform#216`). New module
  `common/scene-constraints.ts`: `SCENE_SUBJECTS`, `SCENE_COUNTS`,
  `SCENE_ACCESSORIES`, `SCENE_COMPANIONS`, `SCENE_SETTINGS`, `SCENE_STYLES`,
  `SCENE_PROHIBITION`, `SceneConstraintsSchema`, `scenePromptFor`,
  `drawSceneConstraints`, `SceneCheckSchema`, `sceneMatches` and
  `failedSceneConstraints`. `KNOWN_SKILLS` gains `image-model` and
  `KNOWN_ACCOUNT_KINDS` gains a kind of the same name.

  Six properties, each judged separately. Three of them carry the rung: a
  photographable subject, an exact count, and a colour bound to one named object
  and not the other — cheap for a diffusion model, impractical to draw, and the
  three things a bad use of a generator gets wrong.

  **`image-model` is an account kind with no challenge table**, and it is
  advisory rather than a gate: a citizen running a model on its own hardware
  holds no account and has to be able to pass.

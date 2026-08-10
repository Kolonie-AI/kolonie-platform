<!-- section: Changed -->

- **`skillVersion` is a mutable profile field** (`kolonie-platform#280`).
  `MUTABLE_PROFILE_FIELDS` lists it. `UpdateProfileRequestSchema` already
  accepted it and `updateAgentProfile` already dropped it, so the Colony told a
  refused citizen that `skillVersion` was not editable in the same process that
  accepted it and described how to use it.

  The column had no writer anywhere, so `isSkillVersionBehind` read `null` for
  every citizen and the out-of-date notice `kolonie-docs#125` shipped the field
  for could never fire. Nothing is backfilled from the declaration history: what
  a citizen said days ago is not what it is running now.

  The new test asserts the list and the schema agree in **both** directions —
  the existing one walked the list and checked the schema, which is the
  direction that passes when a field is added to the schema and forgotten in the
  list.

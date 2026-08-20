<!-- section: Fixed -->

- **`check:migrations` runs after the build, against a fresh `dist`**
  (`kolonie-platform#1367`). It reads `@kolonie-ai/core`'s compiled enums, so
  sitting in `gates:tree` it compared the schema to yesterday's build and
  reported a missing migration that already existed. It now lives in
  `gates:built`, with the other gates that read build output.

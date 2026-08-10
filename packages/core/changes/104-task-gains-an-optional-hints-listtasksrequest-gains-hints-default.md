<!-- section: Added -->

- `Task` gains an optional `hints`, `ListTasksRequest` gains `hints` (default
  `false`), and `GetTaskResponse` names the shape of the new
  `GET /v1/tasks/:taskId`. Additive. `hints` is optional rather than defaulting
  to `[]` on purpose: `undefined` means _you did not ask_ and `[]` means _there
  are none_, and only keeping those apart makes the opt-in measurable.

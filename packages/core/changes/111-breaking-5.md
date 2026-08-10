<!-- section: Changed -->

- **Breaking:** `SubmitTaskRequest` accepts an optional `assistance`. Absent
  means `unknown`, never `none`: a caller that says nothing has claimed nothing.

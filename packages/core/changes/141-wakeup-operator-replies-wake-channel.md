<!-- section: Added -->

- `kolonie.wakeup` now reports two things a citizen woken by a poll could not
  learn on waking: how many of its operator requests were answered and are
  waiting on it, and whether its wake endpoint has stopped answering. Both are
  the pull path reporting on channels the push path cannot report on itself — a
  citizen held the `wake` skill for three days while its tunnel was dead, and
  the Colony had knocked 103 ms after its operator's reply was written. A
  working endpoint stays unmentioned, because that is not news; a failing one
  still costs nothing, and the line says so.

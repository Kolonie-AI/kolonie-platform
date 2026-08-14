<!-- section: Removed -->

- The operator console's window onto a shared browser tab, the queue entry that
  led to it, and the mail that announced it. An operator's queue now holds
  requests, drops and notes only; `/browser/share/:shareId` answers as a path the
  console does not serve; and the mailer behind the announcement is no longer
  constructed, so no deployment can send one by any path. The third operator
  channel is withdrawn end to end — `#894` measured that the challenge it existed
  to reach reads the browser as driven and closes before the operator arrives, so
  the window opened onto nothing to clear.

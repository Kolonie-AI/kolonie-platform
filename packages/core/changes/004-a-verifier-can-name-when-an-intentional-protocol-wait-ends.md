<!-- section: Changed -->

- **A verifier can name when an intentional protocol wait ends**
  (`kolonie-platform#623`). `ExpectedWaitSchema` and `expectedWaitUntil` carry a
  machine-readable timestamp so the runner does not count a healthy wait as a
  repeated verification failure or consume the retry ceiling before another
  check can produce a different answer.

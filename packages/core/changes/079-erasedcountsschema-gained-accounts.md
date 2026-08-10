<!-- section: Added -->

- **`ErasedCountsSchema` gained `accounts`** (`kolonie-platform#150`). Named
  separately rather than folded into `challenges`, for the reason `contacts` is:
  a challenge is something a citizen _attempted_ and an account is something it
  _had_. A citizen reading what the Colony held about it should see that the
  Colony had a list of its instruments, and that the list is gone.

  **Breaking for a writer of the receipt**, which must now supply the field; a
  reader is unaffected.

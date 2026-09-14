<!-- section: Fixed -->

- **Timestamp-like values can be normalised before strict domain validation** (`kolonie-platform#1977`). `toTimestamp` renders Date objects, offset strings, and timezone-less storage values as UTC ISO strings while leaving invalid values for `TimestampSchema` to reject.

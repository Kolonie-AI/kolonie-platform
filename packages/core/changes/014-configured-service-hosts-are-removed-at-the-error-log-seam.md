<!-- section: Added -->

- **Configured service hosts are removed at the error-log seam**
  (`kolonie-platform#676`). `createLog` accepts deployment URLs whose hosts are
  replaced in error messages, stacks and nested causes without changing error
  codes.

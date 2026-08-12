<!-- section: Changed -->

- `ModelCallSchema.fallback` can now carry the HTTP status returned by the route that did not answer, so public accounting can identify both the route that answered and the precise failure that caused the fallback without consulting service logs. The field is optional because timeouts, unreachable routes and malformed replies have no HTTP status. (#781)

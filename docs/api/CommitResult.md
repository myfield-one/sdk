[@myfield/sdk](index.md) / CommitResult

# Type Alias: CommitResult

> **CommitResult** = \{ `ok`: `true`; \} \| \{ `ok`: `false`; `reason`: `"version-mismatch"` \| `"conflict"`; \}

A successful commit or a CAS rejection; other failures throw ClientError.

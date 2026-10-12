# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-13

### Added

- `runBulkQuery()`: starts `bulkOperationRunQuery`, polls `bulkOperation(id:)` (API 2026-01+) or
  `node(id:)` (older versions) with exponential backoff, and resolves with the completed operation.
- Handling for `userErrors`, top-level GraphQL errors, HTTP errors, `FAILED` / `CANCELED` /
  `EXPIRED` statuses, an overall timeout and a caller `AbortSignal`, with best-effort
  `bulkOperationCancel` on timeout or abort.
- Retries for throttled, 429 and 5xx responses while polling (the start mutation is never retried).
- `streamJsonl()` and `parseJsonl()`: chunked JSONL parsing that handles lines and multi-byte
  characters split across chunks, cancels the download when the consumer stops early, and reports
  a body stream that fails part-way through as `NETWORK_ERROR`.
- `nest()` (in-memory, any order) and `groupByParent()` (streaming, grouped files) to rebuild
  parent/child objects from `__parentId`.
- `BulkOperationError` with a typed `code`, plus injectable `fetch` for tests.
- Example: `examples/export-products.ts`.

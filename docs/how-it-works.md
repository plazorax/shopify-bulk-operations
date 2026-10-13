# How it works

A bulk query is three separate jobs, and each is easy to get subtly wrong:

1. **Start** with `bulkOperationRunQuery` and check `userErrors`, not only HTTP status.
2. **Wait** until the status is terminal: back off between polls, stop on `FAILED`, `CANCELED`
   or `EXPIRED`, keep `partialDataUrl` when a run fails, and do not poll forever.
3. **Read** a result file that can be very large. Shopify recommends parsing it line by line
   instead of loading it into memory, and nested connections arrive as separate lines linked by
   `__parentId`.

The library covers those steps as follows.

1. **Start.** `bulkOperationRunQuery(query:)` is sent once. `userErrors` become `USER_ERRORS`.
   The mutation is not retried, so a lost response can never create a second operation.
2. **Poll.** From API version 2026-01, Shopify provides `bulkOperation(id:)` and allows several
   concurrent bulk queries per shop; `currentBulkOperation` is deprecated. For older versions the
   library reads the operation through `node(id:)` instead of `currentBulkOperation`, so it
   always reads the operation it started even if another one exists. The delay grows by
   `backoffFactor` up to `maxPollIntervalMs`. Throttling (`THROTTLED`), HTTP 429/5xx and network
   errors during polling are retried up to `maxPollRetries` times in a row.
3. **Statuses.** `CREATED`, `RUNNING` and `CANCELING` keep polling; `COMPLETED` resolves;
   `FAILED`, `CANCELED` and `EXPIRED` reject. Unknown future statuses keep polling until the
   timeout.
4. **Stop.** The timeout and the caller's signal feed one internal `AbortController`, so a
   request that hangs is cancelled too. On timeout or abort the library sends
   `bulkOperationCancel` (best effort, 5 s limit) so the operation does not keep a concurrency slot.
5. **Stream.** `streamJsonl` reads the response body chunk by chunk with a streaming
   `TextDecoder`, so lines and multi-byte characters split across chunks are reassembled.
   Memory is bounded by the longest line. No Shopify credentials are sent to the result URL,
   which is pre-signed. Breaking out of the loop cancels the download; a connection that drops
   part-way through surfaces as `NETWORK_ERROR`.
6. **Nest.** `nest` indexes every record by `id` and attaches children in a second pass.
   `groupByParent` keeps only the current root and its descendants, and emits the root when the
   next root line arrives.

## Memory trade-off: `nest` vs `groupByParent`

| | `nest` | `groupByParent` |
| --- | --- | --- |
| Memory | whole file + an `id` index | one root object and its children |
| Input order | any | grouped: children after their root, before the next root |
| Output | `Promise<array>` | async iterator |

Shopify documents that children appear after their parents; `groupObjects: true` asks it to
place them directly under their parent. The argument exists from API version 2025-07. Shopify's
default was `true` in 2025-07 and 2025-10 and is `false` from 2026-01, so on 2026-01 and later
set it explicitly if you want to use `groupByParent`. If `groupByParent` meets a child whose
parent is not in the current group, it throws `UNGROUPED_JSONL` rather than returning incomplete
objects (`onOrphan: 'skip'` drops such lines instead).

Sources:
[Perform bulk operations with the GraphQL Admin API](https://shopify.dev/docs/api/usage/bulk-operations/queries),
[bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationRunQuery),
[bulkOperation query](https://shopify.dev/docs/api/admin-graphql/latest/queries/bulkOperation),
[BulkOperationStatus](https://shopify.dev/docs/api/admin-graphql/latest/enums/BulkOperationStatus),
[BulkOperationErrorCode](https://shopify.dev/docs/api/admin-graphql/latest/enums/BulkOperationErrorCode),
[changelog: groupObjects default changed to false](https://shopify.dev/changelog/bulk-operations-group-objects-default-changed-to-false).

## Limitations and roadmap

Limitations in v0.1:

- Bulk **queries** only. Bulk mutations (`bulkOperationRunMutation` with staged uploads) are not
  supported.
- Polling only. There is no helper for the `bulk_operations/finish` webhook, which Shopify
  recommends for production apps; polling is still useful for scripts and as a fallback.
- No query validation beyond "not empty"; Shopify's own `userErrors` are passed through.
- If the abort or timeout fires while the start mutation is in flight, the operation may have
  been created without the library learning its ID, so it cannot be cancelled.
- Tested with mocked responses only; not yet exercised against a live store.

Possible next steps:

- `bulkOperationRunMutation` with JSONL upload via `stagedUploadsCreate`.
- A webhook helper that resolves a pending run from a `bulk_operations/finish` payload.
- Optional retry of the download using HTTP range requests.

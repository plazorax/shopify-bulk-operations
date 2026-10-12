# shopify-bulk-operations

![CI](https://github.com/plazorax/shopify-bulk-operations/actions/workflows/ci.yml/badge.svg)

A small, dependency-free TypeScript library for running Shopify Admin GraphQL bulk query
operations end to end: start the operation, poll it until it finishes, then stream the JSONL
result and rebuild parent/child objects from `__parentId`.

**Status:** v0.1.0 — reference implementation. Not published to npm.
**Tested with:** Node 22.23.1, 20.15.0 and 18.20.0 (unit tests), npm 10.9.8, TypeScript 5.9.3,
Vitest 3.2.7, ESLint 10.12.0; the built type declarations were also checked from a consumer
project with TypeScript 5.0.4, 5.4.5 and 5.9.3. Tests use a mocked `fetch`; this version has not
been run against a live store.

## Why

A bulk query is three separate jobs, and each is easy to get subtly wrong:

1. **Start** with `bulkOperationRunQuery` and check `userErrors`, not only HTTP status.
2. **Wait** until the status is terminal: back off between polls, stop on `FAILED`, `CANCELED`
   or `EXPIRED`, keep `partialDataUrl` when a run fails, and do not poll forever.
3. **Read** a result file that can be very large. Shopify recommends parsing it line by line
   instead of loading it into memory, and nested connections arrive as separate lines linked by
   `__parentId`.

This library covers those three steps with one function each, typed errors, and no runtime
dependencies (it uses the platform `fetch`, `ReadableStream` and `TextDecoder`).

## Quick start

Requirements: Node 18 or newer, an Admin API access token with the scopes your query needs.

```sh
# Not on npm: install from GitHub (the `prepare` script builds dist/ on install)
npm install github:plazorax/shopify-bulk-operations

# or work on it locally
git clone https://github.com/plazorax/shopify-bulk-operations.git
cd shopify-bulk-operations
npm ci
npm run check   # typecheck, lint, test, build (ESLint 10 needs Node 20.19+)
```

```ts
import { runBulkQuery, streamJsonl } from 'shopify-bulk-operations';

const operation = await runBulkQuery({
  shop: 'my-store.myshopify.com',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN!,
  apiVersion: '2026-10',
  query: '{ products { edges { node { id title } } } }',
});

for await (const product of streamJsonl(operation.url)) {
  console.log(product.id, product.title);
}
```

`operation.url` is `null` when the query matched nothing; `streamJsonl(null)` yields nothing.

## Usage

### Options for `runBulkQuery`

| Option | Default | Notes |
| --- | --- | --- |
| `shop` | required | `my-store.myshopify.com` (an `https://` URL is accepted) |
| `accessToken` | required | Sent as `X-Shopify-Access-Token` |
| `apiVersion` | required | e.g. `2026-10`. No default, so upgrades are explicit |
| `query` | required | Bulk query; must return a connection |
| `groupObjects` | not sent | Passed to `bulkOperationRunQuery(groupObjects:)` when set (API 2025-07+) |
| `pollIntervalMs` | `1000` | First delay between polls |
| `maxPollIntervalMs` | `15000` | Backoff ceiling |
| `backoffFactor` | `1.5` | Delay multiplier per poll |
| `timeoutMs` | `3600000` | Budget for start + polling; `Infinity` disables it |
| `maxPollRetries` | `3` | Consecutive retryable poll failures tolerated |
| `cancelOnStop` | `true` | Best-effort `bulkOperationCancel` on timeout or abort |
| `pollStrategy` | `auto` | `bulkOperation` (2026-01+), `node` (older), or `auto` |
| `signal` | — | `AbortSignal` to stop waiting |
| `onProgress` | — | Called with the operation after each poll |
| `fetch` | `globalThis.fetch` | Inject your own for tests or proxies |

### Products with variants, streamed

```ts
import { groupByParent, runBulkQuery, streamJsonl } from 'shopify-bulk-operations';

const operation = await runBulkQuery({
  shop, accessToken, apiVersion: '2026-10',
  groupObjects: true, // children follow their parent in the file
  query: `{
    products { edges { node { id title
      variants { edges { node { id sku price } } }
    } } }
  }`,
});

for await (const product of groupByParent(streamJsonl(operation.url))) {
  const variants = product.__children.ProductVariant ?? [];
  console.log(product.title, variants.map((v) => v.sku));
}
```

Children are attached under `__children`, keyed by the type in their GID
(`gid://shopify/ProductVariant/1` → `ProductVariant`). Pass `childKey` to choose your own keys.
Deeper levels (variant → metafields) are attached to their own parent the same way.

### Small result sets: `nest`

```ts
import { nest, parseJsonl } from 'shopify-bulk-operations';
import { createReadStream } from 'node:fs';

const products = await nest(parseJsonl(createReadStream('result.jsonl')));
```

`nest` accepts records in any order, but keeps every record in memory (see below).

### Errors

Every failure the library recognises is a `BulkOperationError` with a `code`:

```ts
import { BulkOperationError } from 'shopify-bulk-operations';

try {
  await runBulkQuery(options);
} catch (error) {
  if (error instanceof BulkOperationError && error.code === 'FAILED') {
    console.error(error.shopifyErrorCode); // ACCESS_DENIED, INTERNAL_SERVER_ERROR, TIMEOUT
    console.error(error.partialDataUrl);   // may contain the rows fetched before the failure
  }
  throw error;
}
```

Codes: `USER_ERRORS`, `GRAPHQL_ERRORS`, `NETWORK_ERROR`, `HTTP_ERROR`, `INVALID_RESPONSE`,
`FAILED`, `CANCELED`, `EXPIRED`, `TIMEOUT`, `ABORTED`, `INVALID_JSONL`, `ORPHAN_RECORD`,
`UNGROUPED_JSONL`. Invalid configuration (bad shop domain, API version or intervals) throws a
plain `TypeError`.

### Example script

[`examples/export-products.ts`](examples/export-products.ts) exports all products with their
variants as NDJSON:

```sh
SHOPIFY_SHOP=my-store.myshopify.com SHOPIFY_ACCESS_TOKEN=shpat_... \
  node examples/export-products.ts > products.ndjson
```

Node 22.18+ runs `.ts` files directly; on older versions use `npx tsx`.

## How it works

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

### Memory trade-off: `nest` vs `groupByParent`

| | `nest` | `groupByParent` |
| --- | --- | --- |
| Memory | whole file + an `id` index | one root object and its children |
| Input order | any | grouped: children after their root, before the next root |
| Output | `Promise<array>` | async iterator |

Shopify documents that children appear after their parents; `groupObjects: true` asks it to
place them directly under their parent. The argument exists from API version 2025-07. Shopify's
default was `true` in 2025-07 and 2025-10 and is `false` from 2026-01, so on 2026-01 and later
set it explicitly if you want to use `groupByParent`. If `groupByParent` meets a child whose parent is not
in the current group, it throws `UNGROUPED_JSONL` rather than returning incomplete objects
(`onOrphan: 'skip'` drops such lines instead).

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

## License

[MIT](LICENSE) © 2026 Oleksii Shaposhnikov

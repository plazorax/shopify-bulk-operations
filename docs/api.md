# API

Requirements: Node 18 or newer, and an Admin API access token with the scopes your query needs.

## Options for `runBulkQuery`

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

`runBulkQuery` resolves with the `COMPLETED` operation. Its `url` is `null` when the query matched
nothing; `streamJsonl(null)` yields nothing.

## Products with variants, streamed

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

## Small result sets: `nest`

```ts
import { nest, parseJsonl } from 'shopify-bulk-operations';
import { createReadStream } from 'node:fs';

const products = await nest(parseJsonl(createReadStream('result.jsonl')));
```

`nest` accepts records in any order, but keeps every record in memory. See
[the memory trade-off](how-it-works.md#memory-trade-off-nest-vs-groupbyparent).

## Errors

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

## Example script

[`examples/export-products.ts`](../examples/export-products.ts) exports all products with their
variants as NDJSON:

```sh
SHOPIFY_SHOP=my-store.myshopify.com SHOPIFY_ACCESS_TOKEN=shpat_... \
  node examples/export-products.ts > products.ndjson
```

Node 22.18+ runs `.ts` files directly; on older versions use `npx tsx`.

# shopify-bulk-operations

![CI](https://github.com/plazorax/shopify-bulk-operations/actions/workflows/ci.yml/badge.svg)

A small, dependency-free TypeScript library that runs Shopify Admin GraphQL bulk queries end to
end: start the operation, poll it until it finishes, then stream the JSONL result.

## Why

- Starting a bulk query means checking `userErrors`, not only the HTTP status.
- Waiting means backing off, stopping on `FAILED`, `CANCELED` or `EXPIRED`, and never polling forever.
- Result files can be very large, so Shopify recommends reading them line by line instead of
  loading them into memory.
- Nested connections arrive as separate lines linked by `__parentId` and have to be reassembled.

## Install

Requires Node 18 or newer. Not on npm; install from GitHub (`prepare` builds `dist/` on install):

```sh
npm install github:plazorax/shopify-bulk-operations
```

## Usage

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
See [docs/api.md](docs/api.md) for all options, nested results and error handling.

## Features

- Polling with exponential backoff and retries for throttling, HTTP 429/5xx and network errors.
- Typed `BulkOperationError` with a `code`, Shopify's `errorCode` and `partialDataUrl`.
- Overall timeout and `AbortSignal` support, with best-effort `bulkOperationCancel` on stop.
- Streaming JSONL parser: memory is bounded by the longest line, not the file size.
- `nest` (any order, in memory) and `groupByParent` (streaming) rebuild parent/child objects.
- No runtime dependencies: uses the platform `fetch`, `ReadableStream` and `TextDecoder`.

## Status

v0.1.0 — reference implementation. Bulk queries only; no bulk mutations or webhook helper yet.
Tests use a mocked `fetch`; it has not been run against a live store. More in
[how it works](docs/how-it-works.md) (limitations, roadmap) and [development](docs/development.md).

## License

[MIT](LICENSE) © 2026 Oleksii Shaposhnikov

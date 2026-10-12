/**
 * Exports every product with its variants as NDJSON (one product per line) to stdout.
 *
 *   SHOPIFY_SHOP=my-store.myshopify.com \
 *   SHOPIFY_ACCESS_TOKEN=shpat_... \
 *   SHOPIFY_API_VERSION=2026-10 \
 *   node examples/export-products.ts > products.ndjson
 *
 * Needs an Admin API token with the `read_products` scope. Node 22.18+ runs this file directly
 * (built-in type stripping); on older Node versions use `npx tsx examples/export-products.ts`.
 * Progress and errors go to stderr. Ctrl+C cancels the bulk operation.
 */
import { BulkOperationError, groupByParent, runBulkQuery, streamJsonl } from '../src/index.ts';

const QUERY = `{
  products {
    edges {
      node {
        id
        title
        handle
        status
        variants {
          edges { node { id sku price } }
        }
      }
    }
  }
}`;

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });

  const operation = await runBulkQuery({
    shop: env('SHOPIFY_SHOP'),
    accessToken: env('SHOPIFY_ACCESS_TOKEN'),
    apiVersion: env('SHOPIFY_API_VERSION', '2026-10'),
    query: QUERY,
    // Ask Shopify to write each product's variants right after it, so groupByParent can stream.
    groupObjects: true,
    signal: controller.signal,
    onProgress: (op) => {
      console.error(`${op.status}: ${op.objectCount} objects`);
    },
  });

  let products = 0;
  for await (const product of groupByParent(streamJsonl(operation.url, { signal: controller.signal }))) {
    const { id, title, handle, status } = product;
    const variants = (product.__children.ProductVariant ?? []).map((v) => ({ id: v.id, sku: v.sku, price: v.price }));
    process.stdout.write(`${JSON.stringify({ id, title, handle, status, variants })}\n`);
    products += 1;
  }
  console.error(`Exported ${products} products`);
}

main().catch((error: unknown) => {
  if (error instanceof BulkOperationError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.partialDataUrl) console.error(`Partial data: ${error.partialDataUrl}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

import { BulkOperationError } from './errors.ts';
import type { AdminApiOptions, FetchLike, GraphQLErrorItem } from './types.ts';

/** Accepts `my-store.myshopify.com`, `https://my-store.myshopify.com/` or `https://my-store.myshopify.com/admin`. */
export function normalizeShopDomain(shop: string): string {
  const trimmed = shop.trim();
  const host = /^https?:\/\//i.test(trimmed) ? new URL(trimmed).host : trimmed.replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*(:\d+)?$/i.test(host)) {
    throw new TypeError(`Invalid shop domain: "${shop}"`);
  }
  return host.toLowerCase();
}

export function adminGraphqlUrl(shop: string, apiVersion: string): string {
  if (!/^(\d{4}-\d{2}|unstable)$/.test(apiVersion)) {
    throw new TypeError(`Invalid apiVersion "${apiVersion}", expected "YYYY-MM" or "unstable"`);
  }
  return `https://${normalizeShopDomain(shop)}/admin/api/${apiVersion}/graphql.json`;
}

export function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike {
  const impl = fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof impl !== 'function') {
    throw new TypeError('No fetch implementation available; pass options.fetch or use Node 18+');
  }
  return impl;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLErrorItem[];
}

/**
 * Sends one Admin GraphQL request and returns `data`.
 * Abort errors from `fetch` are re-thrown unchanged so callers can tell why they stopped.
 */
export async function adminGraphql<T>(
  options: AdminApiOptions,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const fetchImpl = resolveFetch(options.fetch);
  const url = adminGraphqlUrl(options.shop, options.apiVersion);
  const effectiveSignal = signal ?? options.signal;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': options.accessToken,
      },
      body: JSON.stringify({ query, variables }),
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
    });
  } catch (error) {
    // fetch rejects with `signal.reason`, which is not always an AbortError.
    if (isAbortError(error) || effectiveSignal?.aborted) throw error;
    throw new BulkOperationError('NETWORK_ERROR', `Request to ${url} failed`, { cause: error, retryable: true });
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new BulkOperationError('HTTP_ERROR', `Admin API responded with HTTP ${response.status}`, {
      httpStatus: response.status,
      retryable,
    });
  }

  let body: GraphQLResponse<T>;
  try {
    body = (await response.json()) as GraphQLResponse<T>;
  } catch (error) {
    if (isAbortError(error) || effectiveSignal?.aborted) throw error;
    throw new BulkOperationError('INVALID_RESPONSE', 'Admin API response is not valid JSON', { cause: error });
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const retryable = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    const message = body.errors.map((e) => e.message).join('; ');
    throw new BulkOperationError('GRAPHQL_ERRORS', `GraphQL errors: ${message}`, {
      graphqlErrors: body.errors,
      retryable,
    });
  }

  if (body.data === undefined || body.data === null) {
    throw new BulkOperationError('INVALID_RESPONSE', 'Admin API response has no data');
  }
  return body.data;
}

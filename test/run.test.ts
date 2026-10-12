import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkOperationError, runBulkQuery } from '../src/index.ts';
import type { BulkOperation } from '../src/index.ts';
import type { RunBulkQueryOptions } from '../src/run.ts';
import { OPERATION_ID, data, json, scriptedFetch, started, status } from './helpers.ts';
import type { Handler } from './helpers.ts';

const QUERY = '{ products { edges { node { id title } } } }';

function options(handlers: Handler[], overrides: Partial<RunBulkQueryOptions> = {}) {
  const fetch = scriptedFetch(handlers);
  const opts: RunBulkQueryOptions = {
    shop: 'example.myshopify.com',
    accessToken: 'shpat_test',
    apiVersion: '2026-10',
    query: QUERY,
    pollIntervalMs: 1,
    fetch,
    ...overrides,
  };
  return { fetch, opts };
}

async function rejection(promise: Promise<unknown>): Promise<BulkOperationError> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the promise to reject');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BulkOperationError);
  return error as BulkOperationError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runBulkQuery', () => {
  it('starts the operation, polls until COMPLETED and returns it', async () => {
    const url = 'https://storage.example.com/result.jsonl?signature=abc';
    const progress: BulkOperation[] = [];
    const { fetch, opts } = options(
      [started(), status({ status: 'RUNNING', objectCount: '10' }), status({ status: 'COMPLETED', objectCount: '25', url })],
      { onProgress: (op) => progress.push(op) },
    );

    const result = await runBulkQuery(opts);

    expect(result.status).toBe('COMPLETED');
    expect(result.url).toBe(url);
    expect(result.objectCount).toBe('25');
    expect(progress.map((op) => op.status)).toEqual(['RUNNING', 'COMPLETED']);

    expect(fetch.calls).toHaveLength(3);
    const [start, poll] = fetch.calls;
    expect(start?.url).toBe('https://example.myshopify.com/admin/api/2026-10/graphql.json');
    expect(start?.init?.method).toBe('POST');
    expect((start?.init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_test');
    expect(start?.body?.query).toContain('bulkOperationRunQuery(query: $query)');
    expect(start?.body?.variables).toEqual({ query: QUERY });
    expect(poll?.body?.query).toContain('bulkOperation(id: $id)');
    expect(poll?.body?.variables).toEqual({ id: OPERATION_ID });
  });

  it('returns a COMPLETED operation with a null url when the query matched nothing', async () => {
    const { opts } = options([started(), status({ status: 'COMPLETED', url: null })]);
    const result = await runBulkQuery(opts);
    expect(result.url).toBeNull();
  });

  it('polls with node(id:) for API versions before 2026-01', async () => {
    const { fetch, opts } = options(
      [started(), () => data({ node: { id: OPERATION_ID, status: 'COMPLETED', url: 'https://x.test/r.jsonl' } })],
      { apiVersion: '2025-07' },
    );
    await runBulkQuery(opts);
    expect(fetch.calls[1]?.body?.query).toContain('node(id: $id)');
    expect(fetch.calls[1]?.body?.query).toContain('... on BulkOperation');
  });

  it('passes groupObjects only when it is set', async () => {
    const { fetch, opts } = options([started(), status({ status: 'COMPLETED' })], { groupObjects: true });
    await runBulkQuery(opts);
    expect(fetch.calls[0]?.body?.query).toContain('groupObjects: $groupObjects');
    expect(fetch.calls[0]?.body?.variables).toEqual({ query: QUERY, groupObjects: true });
  });

  it('throws USER_ERRORS when bulkOperationRunQuery returns userErrors', async () => {
    const userErrors = [{ field: ['query'], message: 'Invalid bulk query: must contain at least one connection' }];
    const { fetch, opts } = options([() => data({ bulkOperationRunQuery: { bulkOperation: null, userErrors } })]);

    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('USER_ERRORS');
    expect(error.userErrors).toEqual(userErrors);
    expect(error.message).toContain('must contain at least one connection');
    expect(fetch.calls).toHaveLength(1);
  });

  it('throws FAILED with Shopify errorCode and keeps partialDataUrl', async () => {
    const partialDataUrl = 'https://storage.example.com/partial.jsonl';
    const { opts } = options([started(), status({ status: 'FAILED', errorCode: 'ACCESS_DENIED', partialDataUrl })]);

    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('FAILED');
    expect(error.shopifyErrorCode).toBe('ACCESS_DENIED');
    expect(error.partialDataUrl).toBe(partialDataUrl);
    expect(error.operation?.id).toBe(OPERATION_ID);
  });

  it.each(['CANCELED', 'EXPIRED'] as const)('throws %s for that terminal status', async (terminal) => {
    const { opts } = options([started(), status({ status: 'RUNNING' }), status({ status: terminal })]);
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe(terminal);
  });

  it('keeps polling through CANCELING and unknown future statuses', async () => {
    const { fetch, opts } = options([
      started(),
      status({ status: 'CANCELING' }),
      status({ status: 'SOMETHING_NEW' }),
      status({ status: 'COMPLETED' }),
    ]);
    await runBulkQuery(opts);
    expect(fetch.calls).toHaveLength(4);
  });

  it('throws GRAPHQL_ERRORS for top-level errors on start', async () => {
    const { opts } = options([() => json({ errors: [{ message: 'Access denied for bulkOperationRunQuery field.' }] })]);
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('GRAPHQL_ERRORS');
    expect(error.retryable).toBe(false);
    expect(error.graphqlErrors[0]?.message).toContain('Access denied');
  });

  it('throws HTTP_ERROR for non-2xx responses', async () => {
    const { opts } = options([() => json({ errors: 'Invalid API key or access token' }, 401)]);
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.httpStatus).toBe(401);
  });

  it('throws NETWORK_ERROR when fetch rejects, without retrying the start mutation', async () => {
    const { fetch, opts } = options([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('NETWORK_ERROR');
    expect(fetch.calls).toHaveLength(1);
  });

  it('retries retryable poll failures (HTTP 503, THROTTLED) and then succeeds', async () => {
    const throttled = () => json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
    const { fetch, opts } = options([started(), () => json({}, 503), throttled, status({ status: 'COMPLETED' })]);
    const result = await runBulkQuery(opts);
    expect(result.status).toBe('COMPLETED');
    expect(fetch.calls).toHaveLength(4);
  });

  it('gives up after maxPollRetries consecutive poll failures', async () => {
    const { opts } = options([started(), () => json({}, 502), () => json({}, 502)], { maxPollRetries: 1 });
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.httpStatus).toBe(502);
  });

  it('throws INVALID_RESPONSE when the operation cannot be found', async () => {
    const { opts } = options([started(), () => data({ bulkOperation: null })]);
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('INVALID_RESPONSE');
  });

  it('backs off between polls up to maxPollIntervalMs', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { opts } = options(
      [started(), ...Array.from({ length: 5 }, () => status({ status: 'RUNNING' })), status({ status: 'COMPLETED' })],
      { pollIntervalMs: 1, backoffFactor: 2, maxPollIntervalMs: 4, timeoutMs: 60_000 },
    );
    await runBulkQuery(opts);
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((ms) => ms !== 60_000);
    expect(delays).toEqual([1, 2, 4, 4, 4]);
  });

  it('throws TIMEOUT and cancels the operation when timeoutMs elapses', async () => {
    const running = status({ status: 'RUNNING' });
    const handlers: Handler[] = [started(), ...Array.from({ length: 200 }, () => running)];
    const { fetch, opts } = options(handlers, { pollIntervalMs: 5, maxPollIntervalMs: 5, timeoutMs: 40 });

    const error = await rejection(runBulkQuery(opts));

    expect(error.code).toBe('TIMEOUT');
    expect(error.operation?.status).toBe('RUNNING');
    const last = fetch.calls.at(-1);
    expect(last?.body?.query).toContain('bulkOperationCancel(id: $id)');
    expect(last?.body?.variables).toEqual({ id: OPERATION_ID });
  });

  it('throws TIMEOUT when a request hangs and fetch rejects with the abort reason', async () => {
    const hanging: Handler = ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const { opts } = options([started(), hanging, status()], { timeoutMs: 20 });
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('TIMEOUT');
  });

  it('throws ABORTED when the caller aborts, and can skip the cancel request', async () => {
    const controller = new AbortController();
    const { fetch, opts } = options(
      [
        started(),
        () => {
          controller.abort();
          return data({ bulkOperation: { id: OPERATION_ID, status: 'RUNNING' } });
        },
      ],
      { signal: controller.signal, cancelOnStop: false, pollIntervalMs: 1000 },
    );

    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('ABORTED');
    expect(fetch.calls).toHaveLength(2);
  });

  it('throws ABORTED without any request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, opts } = options([], { signal: controller.signal });
    const error = await rejection(runBulkQuery(opts));
    expect(error.code).toBe('ABORTED');
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects invalid configuration with a TypeError', async () => {
    await expect(runBulkQuery(options([], { apiVersion: 'latest' }).opts)).rejects.toThrow(TypeError);
    await expect(runBulkQuery(options([], { pollIntervalMs: 0 }).opts)).rejects.toThrow(TypeError);
    await expect(runBulkQuery(options([], { backoffFactor: Number.NaN }).opts)).rejects.toThrow(TypeError);
    await expect(runBulkQuery(options([], { query: '  ' }).opts)).rejects.toThrow(TypeError);
  });
});

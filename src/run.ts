import { adminGraphql } from './client.ts';
import { BulkOperationError, isBulkOperationError } from './errors.ts';
import type { AdminApiOptions, BulkOperation, BulkOperationUserError } from './types.ts';

export interface RunBulkQueryOptions extends AdminApiOptions {
  /** The bulk query, e.g. `{ products { edges { node { id title } } } }`. Must return a connection. */
  query: string;
  /**
   * Passed to `bulkOperationRunQuery(groupObjects:)` when set. Shopify documents that grouping
   * places objects directly under their parents but makes the operation slower. Omitted by default.
   */
  groupObjects?: boolean;
  /** First delay between status polls. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Upper bound for the poll delay after backoff. Default 15000 ms. */
  maxPollIntervalMs?: number;
  /** Multiplier applied to the poll delay after each poll. Default 1.5. */
  backoffFactor?: number;
  /** Total time budget for start + polling. Default 1 hour. Use `Infinity` to wait indefinitely. */
  timeoutMs?: number;
  /** Retryable poll failures (HTTP 429/5xx, THROTTLED, network) tolerated in a row. Default 3. */
  maxPollRetries?: number;
  /** Send `bulkOperationCancel` (best effort) when the timeout or the caller's signal stops the run. Default true. */
  cancelOnStop?: boolean;
  /**
   * How to read the operation status. `auto` (default) uses `bulkOperation(id:)` for API versions
   * 2026-01 and later (and `unstable`), and `node(id:)` for older versions.
   */
  pollStrategy?: 'auto' | 'bulkOperation' | 'node';
  /** Called after every successful status poll. */
  onProgress?: (operation: BulkOperation) => void;
}

const OPERATION_FIELDS = 'id status errorCode createdAt completedAt objectCount fileSize url partialDataUrl';

const RUN_MUTATION = `mutation RunBulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const RUN_MUTATION_GROUPED = `mutation RunBulkQuery($query: String!, $groupObjects: Boolean!) {
  bulkOperationRunQuery(query: $query, groupObjects: $groupObjects) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const POLL_BY_BULK_OPERATION = `query BulkOperationStatus($id: ID!) {
  bulkOperation(id: $id) { ${OPERATION_FIELDS} }
}`;

const POLL_BY_NODE = `query BulkOperationStatus($id: ID!) {
  node(id: $id) { ... on BulkOperation { ${OPERATION_FIELDS} } }
}`;

const CANCEL_MUTATION = `mutation CancelBulkOperation($id: ID!) {
  bulkOperationCancel(id: $id) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

interface RunMutationData {
  bulkOperationRunQuery: {
    bulkOperation: { id: string; status: string } | null;
    userErrors: BulkOperationUserError[];
  } | null;
}

const MAX_TIMER_MS = 2_147_483_647;
const NON_TERMINAL = new Set(['CREATED', 'RUNNING', 'CANCELING']);

/** `bulkOperation(id:)` exists from API version 2026-01. */
export function supportsBulkOperationQuery(apiVersion: string): boolean {
  return apiVersion === 'unstable' || apiVersion >= '2026-01';
}

/**
 * Starts a bulk query operation and polls it until it reaches a terminal status.
 *
 * Resolves with the `COMPLETED` operation (its `url` is null when the query matched nothing).
 * Rejects with a {@link BulkOperationError} for every other outcome.
 */
export async function runBulkQuery(options: RunBulkQueryOptions): Promise<BulkOperation> {
  const pollIntervalMs = positive(options.pollIntervalMs ?? 1000, 'pollIntervalMs');
  const maxPollIntervalMs = Math.max(pollIntervalMs, positive(options.maxPollIntervalMs ?? 15_000, 'maxPollIntervalMs'));
  const backoffFactor = Math.max(1, positive(options.backoffFactor ?? 1.5, 'backoffFactor'));
  const timeoutMs = positive(options.timeoutMs ?? 3_600_000, 'timeoutMs');
  const maxPollRetries = Math.max(0, options.maxPollRetries ?? 3);
  const cancelOnStop = options.cancelOnStop ?? true;
  const strategy =
    options.pollStrategy === undefined || options.pollStrategy === 'auto'
      ? supportsBulkOperationQuery(options.apiVersion)
        ? 'bulkOperation'
        : 'node'
      : options.pollStrategy;

  if (options.query.trim() === '') throw new TypeError('query must not be empty');
  if (options.signal?.aborted) {
    throw new BulkOperationError('ABORTED', 'Aborted before the bulk operation was started', {
      cause: options.signal.reason,
    });
  }

  // One internal signal that fires on either the caller's abort or the overall timeout.
  const controller = new AbortController();
  const timeoutReason = new Error('timeout');
  // setTimeout overflows above 2^31-1 ms (~24.8 days), so longer budgets are clamped to that.
  const timer = Number.isFinite(timeoutMs)
    ? setTimeout(() => {
        controller.abort(timeoutReason);
      }, Math.min(timeoutMs, MAX_TIMER_MS))
    : undefined;
  const forwardAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const signal = controller.signal;

  let operationId: string | undefined;
  let operation: BulkOperation | undefined;

  try {
    operationId = await start(options, signal);

    let delay = pollIntervalMs;
    let failures = 0;
    for (;;) {
      try {
        operation = await poll(options, operationId, strategy, signal);
        failures = 0;
      } catch (error) {
        if (isBulkOperationError(error) && error.retryable && failures < maxPollRetries) {
          failures += 1;
          await sleep(delay, signal);
          delay = Math.min(delay * backoffFactor, maxPollIntervalMs);
          continue;
        }
        throw error;
      }

      options.onProgress?.(operation);
      assertNotFailed(operation);
      if (operation.status === 'COMPLETED') return operation;

      await sleep(delay, signal);
      delay = Math.min(delay * backoffFactor, maxPollIntervalMs);
    }
  } catch (error) {
    // Whatever failed after the internal signal fired is a consequence of stopping.
    if (signal.aborted) {
      if (cancelOnStop && operationId !== undefined && (!operation || NON_TERMINAL.has(operation.status))) {
        await cancelQuietly(options, operationId);
      }
      throw signal.reason === timeoutReason
        ? new BulkOperationError('TIMEOUT', `Bulk operation did not finish within ${timeoutMs} ms`, {
            ...(operation ? { operation } : {}),
            cause: error,
          })
        : new BulkOperationError('ABORTED', 'Bulk operation polling was aborted', {
            ...(operation ? { operation } : {}),
            cause: options.signal?.reason ?? error,
          });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function start(options: RunBulkQueryOptions, signal: AbortSignal): Promise<string> {
  const grouped = options.groupObjects !== undefined;
  const data = await adminGraphql<RunMutationData>(
    options,
    grouped ? RUN_MUTATION_GROUPED : RUN_MUTATION,
    grouped ? { query: options.query, groupObjects: options.groupObjects } : { query: options.query },
    signal,
  );
  const payload = data.bulkOperationRunQuery;
  if (payload && payload.userErrors.length > 0) {
    const message = payload.userErrors.map((e) => e.message).join('; ');
    throw new BulkOperationError('USER_ERRORS', `bulkOperationRunQuery failed: ${message}`, {
      userErrors: payload.userErrors,
    });
  }
  if (!payload?.bulkOperation?.id) {
    throw new BulkOperationError('INVALID_RESPONSE', 'bulkOperationRunQuery returned no bulk operation');
  }
  return payload.bulkOperation.id;
}

async function poll(
  options: AdminApiOptions,
  id: string,
  strategy: 'bulkOperation' | 'node',
  signal: AbortSignal,
): Promise<BulkOperation> {
  let operation: Partial<BulkOperation> | null | undefined;
  if (strategy === 'bulkOperation') {
    const data = await adminGraphql<{ bulkOperation: BulkOperation | null }>(options, POLL_BY_BULK_OPERATION, { id }, signal);
    operation = data.bulkOperation;
  } else {
    const data = await adminGraphql<{ node: Partial<BulkOperation> | null }>(options, POLL_BY_NODE, { id }, signal);
    operation = data.node;
  }
  if (!operation || typeof operation.status !== 'string' || operation.id !== id) {
    throw new BulkOperationError('INVALID_RESPONSE', `Bulk operation ${id} was not found`);
  }
  return operation as BulkOperation;
}

function assertNotFailed(operation: BulkOperation): void {
  switch (operation.status) {
    case 'FAILED':
      throw new BulkOperationError(
        'FAILED',
        `Bulk operation ${operation.id} failed${operation.errorCode ? ` with ${operation.errorCode}` : ''}`,
        { operation, shopifyErrorCode: operation.errorCode },
      );
    case 'CANCELED':
      throw new BulkOperationError('CANCELED', `Bulk operation ${operation.id} was canceled`, { operation });
    case 'EXPIRED':
      throw new BulkOperationError('EXPIRED', `Bulk operation ${operation.id} expired`, { operation });
    default:
      // COMPLETED, non-terminal statuses and statuses added by future API versions.
      return;
  }
}

/** Best effort: the run is already being stopped, so a failed cancel must not mask the real reason. */
async function cancelQuietly(options: AdminApiOptions, id: string): Promise<void> {
  try {
    await adminGraphql(options, CANCEL_MUTATION, { id }, AbortSignal.timeout(5000));
  } catch {
    // ignored on purpose
  }
}

function positive(value: number, name: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

/**
 * Resolves after `ms` (clamped to the largest delay `setTimeout` supports), or rejects with an
 * `AbortError` as soon as `signal` fires.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(ms, MAX_TIMER_MS));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

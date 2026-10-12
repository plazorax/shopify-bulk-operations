import type { BulkOperation, BulkOperationUserError, GraphQLErrorItem } from './types.ts';

/**
 * Machine-readable reason attached to every {@link BulkOperationError}.
 *
 * - `USER_ERRORS`      – `bulkOperationRunQuery` returned `userErrors` (bad query, limit reached, ...).
 * - `GRAPHQL_ERRORS`   – the GraphQL response contained top-level `errors` (auth, throttling, syntax).
 * - `NETWORK_ERROR`    – `fetch` itself rejected (DNS, connection reset, ...).
 * - `HTTP_ERROR`       – a non-2xx HTTP response from the Admin API or the result URL.
 * - `INVALID_RESPONSE` – the response body was not the shape this library expects.
 * - `FAILED`           – the operation finished with status `FAILED` (see `shopifyErrorCode`).
 * - `CANCELED`         – the operation was canceled (by this library, another client or Shopify).
 * - `EXPIRED`          – the operation's result URL expired before it could be used.
 * - `TIMEOUT`          – `timeoutMs` elapsed before the operation reached a terminal status.
 * - `ABORTED`          – the caller's `AbortSignal` fired.
 * - `INVALID_JSONL`    – a line of the result file is not valid JSON.
 * - `ORPHAN_RECORD`    – a JSONL record references a `__parentId` that was never seen.
 * - `UNGROUPED_JSONL`  – `groupByParent` saw a child after its parent group had already been emitted.
 */
export type BulkOperationErrorCode =
  | 'USER_ERRORS'
  | 'GRAPHQL_ERRORS'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'FAILED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INVALID_JSONL'
  | 'ORPHAN_RECORD'
  | 'UNGROUPED_JSONL';

export interface BulkOperationErrorDetails {
  /** Last known snapshot of the bulk operation, when one exists. */
  operation?: BulkOperation;
  /** Shopify's `BulkOperation.errorCode` (e.g. `ACCESS_DENIED`, `TIMEOUT`) for `FAILED` operations. */
  shopifyErrorCode?: string | null;
  userErrors?: BulkOperationUserError[];
  graphqlErrors?: GraphQLErrorItem[];
  /** HTTP status code for `HTTP_ERROR`. */
  httpStatus?: number;
  /** 1-based line number for JSONL errors. */
  line?: number;
  /** Whether repeating the same request might succeed (throttling, 5xx). */
  retryable?: boolean;
  cause?: unknown;
}

export class BulkOperationError extends Error {
  override readonly name = 'BulkOperationError';
  readonly code: BulkOperationErrorCode;
  readonly operation: BulkOperation | undefined;
  readonly shopifyErrorCode: string | null | undefined;
  readonly userErrors: BulkOperationUserError[];
  readonly graphqlErrors: GraphQLErrorItem[];
  readonly httpStatus: number | undefined;
  readonly line: number | undefined;
  readonly retryable: boolean;

  constructor(code: BulkOperationErrorCode, message: string, details: BulkOperationErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.operation = details.operation;
    this.shopifyErrorCode = details.shopifyErrorCode;
    this.userErrors = details.userErrors ?? [];
    this.graphqlErrors = details.graphqlErrors ?? [];
    this.httpStatus = details.httpStatus;
    this.line = details.line;
    this.retryable = details.retryable ?? false;
  }

  /** URL of partial results, available for some `FAILED` operations. */
  get partialDataUrl(): string | null {
    return this.operation?.partialDataUrl ?? null;
  }
}

export function isBulkOperationError(value: unknown): value is BulkOperationError {
  return value instanceof BulkOperationError;
}

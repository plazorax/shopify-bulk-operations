/** Minimal `fetch` signature used by this library, so tests and other runtimes can inject their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Values of Shopify's `BulkOperationStatus` enum.
 * The `string & {}` member keeps unknown future values type-safe without breaking autocompletion.
 */
export type BulkOperationStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'CANCELING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'EXPIRED'
  | (string & {});

/** The fields of Shopify's `BulkOperation` object that this library selects. */
export interface BulkOperation {
  id: string;
  status: BulkOperationStatus;
  /** `BulkOperationErrorCode`: `ACCESS_DENIED`, `INTERNAL_SERVER_ERROR`, `TIMEOUT`, or null. */
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  /** `UnsignedInt64`, serialized by Shopify as a string. */
  objectCount: string;
  /** `UnsignedInt64`, serialized by Shopify as a string. Null until the file exists. */
  fileSize: string | null;
  /** Signed JSONL download URL. Null when the query matched nothing. Expires after 7 days. */
  url: string | null;
  /** Signed URL with partial JSONL data for some failed operations. */
  partialDataUrl: string | null;
}

export interface BulkOperationUserError {
  field: string[] | null;
  message: string;
}

export interface GraphQLErrorItem {
  message: string;
  extensions?: { code?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Connection settings shared by every call that talks to the Admin API. */
export interface AdminApiOptions {
  /** Shop domain, e.g. `my-store.myshopify.com`. A full `https://` URL is accepted too. */
  shop: string;
  /** Admin API access token (sent as `X-Shopify-Access-Token`). */
  accessToken: string;
  /** Admin API version, e.g. `2026-10`. Pin this explicitly; there is no default. */
  apiVersion: string;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** One decoded line of a bulk operation JSONL file. */
export interface JsonlRecord {
  id?: string;
  __parentId?: string;
  [key: string]: unknown;
}

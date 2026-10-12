import type { FetchLike } from '../src/types.ts';

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  /** Parsed JSON request body, when there is one. */
  body: { query: string; variables: Record<string, unknown> } | undefined;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * A scripted fetch: each request consumes the next handler. Running out of handlers fails the test,
 * so every test states exactly which requests it expects.
 */
export function scriptedFetch(handlers: Handler[]): FetchLike & { calls: RecordedCall[] } {
  const queue = [...handlers];
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url,
      init,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as RecordedCall['body']) : undefined,
    };
    calls.push(call);
    const handler = queue.shift();
    if (!handler) throw new Error(`Unexpected request #${calls.length} to ${url}`);
    return handler(call);
  };
  return Object.assign(fetchImpl, { calls });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const data = (payload: unknown): Response => json({ data: payload });

export const OPERATION_ID = 'gid://shopify/BulkOperation/1';

export function started(id = OPERATION_ID): Handler {
  return () => data({ bulkOperationRunQuery: { bulkOperation: { id, status: 'CREATED' }, userErrors: [] } });
}

export function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OPERATION_ID,
    status: 'RUNNING',
    errorCode: null,
    createdAt: '2026-10-01T00:00:00Z',
    completedAt: null,
    objectCount: '0',
    fileSize: null,
    url: null,
    partialDataUrl: null,
    ...overrides,
  };
}

/** Responds to a `bulkOperation(id:)` poll. */
export function status(overrides: Record<string, unknown> = {}): Handler {
  return () => data({ bulkOperation: operation(overrides) });
}

/** Builds a byte stream from chunks, optionally tracking cancellation. */
export function byteStream(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** Splits bytes into fixed-size chunks, deliberately cutting through lines and multi-byte characters. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return chunks;
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

import { isAbortError, resolveFetch } from './client.ts';
import { BulkOperationError } from './errors.ts';
import type { FetchLike, JsonlRecord } from './types.ts';

/** Anything that yields bytes or text: a web `ReadableStream`, a Node `Readable`, an async generator. */
export type JsonlSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

export interface StreamJsonlOptions {
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Downloads a bulk operation result file and yields one parsed object per line.
 *
 * The response body is consumed chunk by chunk, so memory use is bounded by the longest line,
 * not by the file size. `url` may be null (a completed operation with no results); nothing is
 * yielded in that case. No Shopify credentials are sent: result URLs are pre-signed.
 * Breaking out of the loop early cancels the download.
 */
export async function* streamJsonl<T = JsonlRecord>(
  url: string | null | undefined,
  options: StreamJsonlOptions = {},
): AsyncGenerator<T, void, undefined> {
  if (!url) return;
  const fetchImpl = resolveFetch(options.fetch);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, options.signal ? { signal: options.signal } : {});
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      throw new BulkOperationError('NETWORK_ERROR', 'Downloading the bulk operation result failed', {
        cause: error,
        retryable: true,
      });
    }
    if (!response.ok) {
      const hint = response.status === 403 ? ' (result URLs expire 7 days after the operation finishes)' : '';
      throw new BulkOperationError('HTTP_ERROR', `Result download responded with HTTP ${response.status}${hint}`, {
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    if (!response.body) {
      throw new BulkOperationError('INVALID_RESPONSE', 'Result download has no response body');
    }
    yield* parseJsonl<T>(response.body);
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw new BulkOperationError('ABORTED', 'Result download was aborted', { cause: error });
    }
    if (error instanceof BulkOperationError) throw error;
    // The body stream failed part-way through (connection reset, truncated response, ...).
    throw new BulkOperationError('NETWORK_ERROR', 'Reading the bulk operation result failed', {
      cause: error,
      retryable: true,
    });
  }
}

/**
 * Parses JSONL from any byte or text source. Empty lines and `\r\n` line endings are accepted.
 * Throws a `BulkOperationError` with code `INVALID_JSONL` and the 1-based `line` on bad input.
 *
 * @example
 * for await (const row of parseJsonl(fs.createReadStream('result.jsonl'))) { ... }
 */
export async function* parseJsonl<T = JsonlRecord>(source: JsonlSource): AsyncGenerator<T, void, undefined> {
  let lineNumber = 0;
  for await (const line of splitLines(source)) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    let value: T;
    try {
      value = JSON.parse(line) as T;
    } catch (error) {
      throw new BulkOperationError('INVALID_JSONL', `Invalid JSON on line ${lineNumber}`, {
        line: lineNumber,
        cause: error,
      });
    }
    yield value;
  }
}

/** Yields text lines without the trailing `\n` / `\r\n`. Multi-byte characters split across chunks are handled. */
export async function* splitLines(source: JsonlSource): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for await (const chunk of iterate(source)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline = buffer.indexOf('\n', start);
    while (newline !== -1) {
      yield stripCarriageReturn(buffer.slice(start, newline));
      start = newline + 1;
      newline = buffer.indexOf('\n', start);
    }
    buffer = buffer.slice(start);
  }

  buffer += decoder.decode();
  if (buffer !== '') yield stripCarriageReturn(buffer);
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

async function* iterate(source: JsonlSource): AsyncGenerator<Uint8Array | string, void, undefined> {
  if (!isReadableStream(source)) {
    yield* source;
    return;
  }
  const reader = source.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    // The consumer stopped early (break/throw): release the underlying connection.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isReadableStream(source: JsonlSource): source is ReadableStream<Uint8Array> {
  return typeof (source as ReadableStream<Uint8Array>).getReader === 'function';
}

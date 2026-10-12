import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BulkOperationError, parseJsonl, streamJsonl } from '../src/index.ts';
import { byteStream, chunkBytes, collect, scriptedFetch } from './helpers.ts';

const RECORDS = [
  { id: 'gid://shopify/Product/1', title: 'Футболка' },
  { id: 'gid://shopify/ProductVariant/11', title: 'S / 🟥', __parentId: 'gid://shopify/Product/1' },
  { id: 'gid://shopify/ProductVariant/12', title: 'M / 🟦', __parentId: 'gid://shopify/Product/1' },
  { id: 'gid://shopify/Product/2', title: 'Café mug "large"' },
];
const TEXT = RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n';
const BYTES = new TextEncoder().encode(TEXT);

describe('parseJsonl', () => {
  it.each([1, 2, 3, 5, 7, 64, BYTES.length])(
    'parses identically when the stream is cut into %i-byte chunks',
    async (size) => {
      const rows = await collect(parseJsonl(byteStream(chunkBytes(BYTES, size))));
      expect(rows).toEqual(RECORDS);
    },
  );

  it('accepts CRLF line endings, blank lines and a missing trailing newline', async () => {
    const text = '{"a":1}\r\n\r\n{"a":2}\n\n{"a":3}';
    const rows = await collect(parseJsonl(byteStream([new TextEncoder().encode(text)])));
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('accepts Node readable streams and string chunks', async () => {
    const rows = await collect(parseJsonl(Readable.from(['{"a":1}\n{"a"', ':2}\n'])));
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('yields nothing for an empty source', async () => {
    expect(await collect(parseJsonl(byteStream([])))).toEqual([]);
  });

  it('reports the line number of invalid JSON', async () => {
    const stream = byteStream([new TextEncoder().encode('{"a":1}\n{"a":\n{"a":3}\n')]);
    const error = await collect(parseJsonl(stream)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BulkOperationError);
    expect((error as BulkOperationError).code).toBe('INVALID_JSONL');
    expect((error as BulkOperationError).line).toBe(2);
  });
});

describe('streamJsonl', () => {
  it('downloads the result URL without Shopify credentials and yields records', async () => {
    const fetch = scriptedFetch([() => new Response(byteStream(chunkBytes(BYTES, 9)))]);
    const rows = await collect(streamJsonl('https://storage.example.com/r.jsonl', { fetch }));

    expect(rows).toEqual(RECORDS);
    expect(fetch.calls[0]?.url).toBe('https://storage.example.com/r.jsonl');
    expect(fetch.calls[0]?.init?.headers).toBeUndefined();
  });

  it('yields nothing and makes no request for a null url', async () => {
    const fetch = scriptedFetch([]);
    expect(await collect(streamJsonl(null, { fetch }))).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws HTTP_ERROR with an expiry hint on 403', async () => {
    const fetch = scriptedFetch([() => new Response('denied', { status: 403 })]);
    const error = await collect(streamJsonl('https://storage.example.com/r.jsonl', { fetch })).catch((e: unknown) => e);
    expect((error as BulkOperationError).code).toBe('HTTP_ERROR');
    expect((error as BulkOperationError).httpStatus).toBe(403);
    expect((error as BulkOperationError).message).toContain('expire');
  });

  it('cancels the download when the consumer stops early', async () => {
    let canceled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"gid://shopify/Product/1"}\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetch = scriptedFetch([() => new Response(endless)]);

    let seen = 0;
    for await (const row of streamJsonl('https://storage.example.com/r.jsonl', { fetch })) {
      expect(row).toEqual({ id: 'gid://shopify/Product/1' });
      if (++seen === 3) break;
    }
    expect(canceled).toBe(true);
  });

  it('throws NETWORK_ERROR when the body stream fails part-way through', async () => {
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError('terminated'));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"id":"gid://shopify/Product/1"}\n'));
      },
    });
    const fetch = scriptedFetch([() => new Response(broken)]);
    const rows: unknown[] = [];
    const error = await (async () => {
      for await (const row of streamJsonl('https://storage.example.com/r.jsonl', { fetch })) rows.push(row);
    })().catch((e: unknown) => e);

    expect(rows).toEqual([{ id: 'gid://shopify/Product/1' }]);
    expect(error).toBeInstanceOf(BulkOperationError);
    expect((error as BulkOperationError).code).toBe('NETWORK_ERROR');
    expect((error as BulkOperationError).cause).toBeInstanceOf(TypeError);
  });

  it('throws ABORTED when the signal fires during the download', async () => {
    const controller = new AbortController();
    const fetch = scriptedFetch([
      () => {
        controller.abort();
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    ]);
    const error = await collect(
      streamJsonl('https://storage.example.com/r.jsonl', { fetch, signal: controller.signal }),
    ).catch((e: unknown) => e);
    expect((error as BulkOperationError).code).toBe('ABORTED');
  });
});

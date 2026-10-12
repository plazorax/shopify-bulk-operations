import { describe, expect, it } from 'vitest';
import { BulkOperationError, gidType, groupByParent, nest } from '../src/index.ts';
import type { JsonlRecord } from '../src/index.ts';
import { collect } from './helpers.ts';

const P1 = 'gid://shopify/Product/1';
const P2 = 'gid://shopify/Product/2';
const V11 = 'gid://shopify/ProductVariant/11';

/** Shape of a products -> variants (-> metafields) export with grouped output. */
const GROUPED: JsonlRecord[] = [
  { id: P1, title: 'Shirt' },
  { id: V11, sku: 'SHIRT-S', __parentId: P1 },
  { id: 'gid://shopify/Metafield/900', key: 'fit', __parentId: V11 },
  { id: 'gid://shopify/ProductVariant/12', sku: 'SHIRT-M', __parentId: P1 },
  { id: 'gid://shopify/MediaImage/50', alt: 'Front', __parentId: P1 },
  { id: P2, title: 'Mug' },
  { id: 'gid://shopify/ProductVariant/21', sku: 'MUG', __parentId: P2 },
];

async function* asAsync<T>(items: T[], onYield?: (index: number) => void): AsyncGenerator<T> {
  for (const [index, item] of items.entries()) {
    onYield?.(index);
    yield await Promise.resolve(item);
  }
}

describe('gidType', () => {
  it('extracts the resource type from a Shopify GID', () => {
    expect(gidType('gid://shopify/ProductVariant/11')).toBe('ProductVariant');
    expect(gidType('gid://shopify/Product/1?x=1')).toBe('Product');
    expect(gidType('not-a-gid')).toBeUndefined();
    expect(gidType(42)).toBeUndefined();
  });
});

describe('nest', () => {
  it('attaches children and grandchildren grouped by GID type, preserving file order', async () => {
    const [shirt, mug] = await nest(GROUPED);

    expect(shirt?.title).toBe('Shirt');
    expect(shirt?.__children.ProductVariant?.map((v) => v.sku)).toEqual(['SHIRT-S', 'SHIRT-M']);
    expect(shirt?.__children.MediaImage?.[0]?.alt).toBe('Front');
    expect(shirt?.__children.ProductVariant?.[0]?.__children.Metafield?.[0]?.key).toBe('fit');
    expect(mug?.__children.ProductVariant).toHaveLength(1);
  });

  it('does not mutate the input records', async () => {
    const input: JsonlRecord[] = [{ id: P1 }, { id: V11, __parentId: P1 }];
    await nest(input);
    expect(input[0]).toEqual({ id: P1 });
  });

  it('handles interleaved (ungrouped) files and children listed before parents', async () => {
    const roots = await nest(
      asAsync<JsonlRecord>([
        { id: 'gid://shopify/ProductVariant/21', __parentId: P2 },
        { id: P1 },
        { id: P2 },
        { id: V11, __parentId: P1 },
      ]),
    );
    expect(roots.map((r) => r.id)).toEqual([P1, P2]);
    expect(roots[0]?.__children.ProductVariant?.[0]?.id).toBe(V11);
    expect(roots[1]?.__children.ProductVariant?.[0]?.id).toBe('gid://shopify/ProductVariant/21');
  });

  it('supports a custom childKey', async () => {
    const [shirt] = await nest(GROUPED, {
      childKey: (r) => ({ ProductVariant: 'variants', MediaImage: 'media' })[gidType(r.id) ?? ''] ?? 'other',
    });
    expect(Object.keys(shirt?.__children ?? {})).toEqual(['variants', 'media']);
  });

  it('throws ORPHAN_RECORD for a missing parent, or skips it on request', async () => {
    const records: JsonlRecord[] = [{ id: P1 }, { id: V11, __parentId: 'gid://shopify/Product/404' }];
    const error = await nest(records).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BulkOperationError);
    expect((error as BulkOperationError).code).toBe('ORPHAN_RECORD');

    const roots = await nest(records, { onOrphan: 'skip' });
    expect(roots[0]?.__children).toEqual({});
  });
});

describe('groupByParent', () => {
  it('yields each root with its full subtree', async () => {
    const roots = await collect(groupByParent(GROUPED));
    expect(roots).toEqual(await nest(GROUPED));
  });

  it('emits a root before reading past the next root line (streaming)', async () => {
    let lastRead = -1;
    const iterator = groupByParent(asAsync(GROUPED, (i) => (lastRead = i)));

    const first = await iterator.next();
    expect(first.value?.id).toBe(P1);
    // Index 5 is the second product line: it had to be read to know the first product was complete.
    expect(lastRead).toBe(5);
    await iterator.return(undefined);
  });

  it('throws UNGROUPED_JSONL when a child appears outside its parent group', async () => {
    const ungrouped: JsonlRecord[] = [{ id: P1 }, { id: P2 }, { id: V11, __parentId: P1 }];
    const error = await collect(groupByParent(ungrouped)).catch((e: unknown) => e);
    expect((error as BulkOperationError).code).toBe('UNGROUPED_JSONL');
    expect((error as BulkOperationError).message).toContain('groupObjects');
  });

  it('skips out-of-group children with onOrphan: "skip"', async () => {
    const ungrouped: JsonlRecord[] = [{ id: P1 }, { id: P2 }, { id: V11, __parentId: P1 }];
    const roots = await collect(groupByParent(ungrouped, { onOrphan: 'skip' }));
    expect(roots.map((r) => r.__children)).toEqual([{}, {}]);
  });

  it('yields nothing for an empty source', async () => {
    expect(await collect(groupByParent([]))).toEqual([]);
  });
});

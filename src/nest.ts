import { BulkOperationError } from './errors.ts';
import type { JsonlRecord } from './types.ts';

/** A JSONL record with its children attached, grouped by a key (by default the child's GID type). */
export type NestedRecord<T extends JsonlRecord = JsonlRecord> = T & {
  __children: Record<string, NestedRecord[]>;
};

export interface NestOptions {
  /**
   * Chooses the `__children` key for a child record. Defaults to the type in its GID,
   * e.g. `gid://shopify/ProductVariant/1` -> `ProductVariant`; records without a GID use `Unknown`.
   */
  childKey?: (record: JsonlRecord) => string;
  /** What to do with a record whose `__parentId` has no matching parent. Default `throw`. */
  onOrphan?: 'throw' | 'skip';
}

type RecordSource = Iterable<JsonlRecord> | AsyncIterable<JsonlRecord>;

/** Returns `ProductVariant` for `gid://shopify/ProductVariant/123`, or undefined for anything else. */
export function gidType(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  return /^gid:\/\/shopify\/([^/]+)\//.exec(id)?.[1];
}

function defaultChildKey(record: JsonlRecord): string {
  return gidType(record.id) ?? 'Unknown';
}

function toNested<T extends JsonlRecord>(record: T): NestedRecord<T> {
  return { ...record, __children: {} };
}

function attach(parent: NestedRecord, child: NestedRecord, key: string): void {
  const list = parent.__children[key];
  if (list) list.push(child);
  else parent.__children[key] = [child];
}

/**
 * Rebuilds the full parent/child tree from bulk operation records (any depth, any order).
 *
 * Memory trade-off: every record is held in memory until the source is exhausted, plus a
 * `Map` from `id` to record. That is fine for thousands of rows and wrong for millions.
 * For large exports, use {@link groupByParent}, which keeps only one root object at a time.
 */
export async function nest<T extends JsonlRecord = JsonlRecord>(
  source: RecordSource,
  options: NestOptions = {},
): Promise<Array<NestedRecord<T>>> {
  const childKey = options.childKey ?? defaultChildKey;
  const byId = new Map<string, NestedRecord>();
  const roots: Array<NestedRecord<T>> = [];
  const children: NestedRecord[] = [];

  for await (const record of source) {
    const node = toNested(record);
    if (typeof record.id === 'string') byId.set(record.id, node);
    if (record.__parentId === undefined) roots.push(node as NestedRecord<T>);
    else children.push(node);
  }

  // Second pass so that children are attached even if they appear before their parent.
  for (const child of children) {
    const parentId = child.__parentId as string;
    const parent = byId.get(parentId);
    if (!parent) {
      if (options.onOrphan === 'skip') continue;
      throw new BulkOperationError('ORPHAN_RECORD', `No record with id ${parentId} (parent of ${String(child.id)})`);
    }
    attach(parent, child, childKey(child));
  }
  return roots;
}

/**
 * Streams root objects with their descendants attached, one root at a time.
 *
 * Assumes the file is grouped: every child line follows its root (directly or via another child)
 * before the next root line starts. Run the operation with `groupObjects: true` to ask Shopify for
 * that layout. If a child refers to a parent outside the current group, this throws
 * `UNGROUPED_JSONL` instead of silently returning incomplete objects (or skips it with
 * `onOrphan: 'skip'`). Memory use is bounded by the size of the largest root object.
 */
export async function* groupByParent<T extends JsonlRecord = JsonlRecord>(
  source: RecordSource,
  options: NestOptions = {},
): AsyncGenerator<NestedRecord<T>, void, undefined> {
  const childKey = options.childKey ?? defaultChildKey;
  let current: NestedRecord<T> | undefined;
  let index = new Map<string, NestedRecord>();

  for await (const record of source) {
    const node = toNested(record);

    if (record.__parentId === undefined) {
      if (current) yield current;
      current = node as NestedRecord<T>;
      index = new Map();
      if (typeof record.id === 'string') index.set(record.id, node);
      continue;
    }

    const parent = index.get(record.__parentId);
    if (!parent) {
      if (options.onOrphan === 'skip') continue;
      throw new BulkOperationError(
        'UNGROUPED_JSONL',
        `Parent ${record.__parentId} of ${String(record.id)} is not in the current group. ` +
          'The file is not grouped by parent (start the operation with groupObjects: true, or use nest()).',
      );
    }
    attach(parent, node, childKey(record));
    if (typeof record.id === 'string') index.set(record.id, node);
  }

  if (current) yield current;
}

import { describe, expect, it } from 'vitest';
import { adminGraphqlUrl, normalizeShopDomain } from '../src/index.ts';

describe('normalizeShopDomain', () => {
  it.each([
    ['my-store.myshopify.com', 'my-store.myshopify.com'],
    ['  My-Store.myshopify.com ', 'my-store.myshopify.com'],
    ['https://my-store.myshopify.com/', 'my-store.myshopify.com'],
    ['https://my-store.myshopify.com/admin/products', 'my-store.myshopify.com'],
    ['my-store.myshopify.com/admin', 'my-store.myshopify.com'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeShopDomain(input)).toBe(expected);
  });

  it.each(['', 'https://', 'bad domain.com', '../etc'])('rejects %j', (input) => {
    expect(() => normalizeShopDomain(input)).toThrow(TypeError);
  });
});

describe('adminGraphqlUrl', () => {
  it('builds the versioned Admin GraphQL endpoint', () => {
    expect(adminGraphqlUrl('my-store.myshopify.com', '2026-10')).toBe(
      'https://my-store.myshopify.com/admin/api/2026-10/graphql.json',
    );
    expect(adminGraphqlUrl('my-store.myshopify.com', 'unstable')).toContain('/admin/api/unstable/');
  });

  it('rejects malformed API versions', () => {
    expect(() => adminGraphqlUrl('my-store.myshopify.com', '2026-1')).toThrow(TypeError);
  });
});

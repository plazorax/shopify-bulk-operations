# Development

```sh
git clone https://github.com/plazorax/shopify-bulk-operations.git
cd shopify-bulk-operations
npm ci
npm run check   # typecheck, lint, test, build (ESLint 10 needs Node 20.19+)
```

Individual scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:watch`,
`npm run build`.

CI runs typecheck, lint, test, build and `npm pack --dry-run` on Node 20 and 22.

## Tested with

- Unit tests on Node 22.23.1, 20.15.0 and 18.20.0, with npm 10.9.8, TypeScript 5.9.3,
  Vitest 3.2.7 and ESLint 10.12.0.
- The built type declarations were also checked from a consumer project with TypeScript 5.0.4,
  5.4.5 and 5.9.3.
- Tests use a mocked `fetch`; this version has not been run against a live store.

// Minimal ambient types for the handful of Node builtins used by
// test/store.test.ts's D1 test fake (a real-SQLite-backed adapter — see that
// file for why). Deliberately NOT `@types/node`: tsconfig.json scopes
// `types` to `@cloudflare/workers-types` only so the Worker source tree
// can't silently typecheck against Node globals that don't exist in the
// Workers runtime. These narrow shims cover only what's actually called.

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
  export class StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

interface ImportMeta {
  url: string;
}

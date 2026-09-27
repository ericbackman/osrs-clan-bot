import { describe, it, expect } from "vitest";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Store } from "../src/store";

// ── minimal D1-shaped adapter over real SQLite ──────────────────────────────
// `Store` binds parameters positionally the same way D1 does (`.prepare(sql)
// .bind(...args).run()`), so a thin wrapper around node's built-in
// node:sqlite gives genuine SQLite UPSERT/WHERE-guard semantics (real
// `changes()` after an ON CONFLICT ... WHERE that doesn't match) without
// pulling in miniflare/vitest-pool-workers just for this one guarded query.
function makeFakeD1() {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));

  function wrap(stmt: StatementSync, args: unknown[]) {
    return {
      run: async () => {
        const res = stmt.run(...(args as never[]));
        return { success: true, meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
      },
      first: async <T>() => (stmt.get(...(args as never[])) as T | undefined) ?? null,
      all: async <T>() => ({ results: stmt.all(...(args as never[])) as T[] }),
    };
  }

  const fake = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return { bind: (...args: unknown[]) => wrap(stmt, args) };
    },
    // Store.linkDiscord doesn't call batch(); other Store methods do, but
    // they're out of scope for these tests.
    batch: async () => {
      throw new Error("batch() not implemented in this test fake");
    },
  };
  return fake as unknown as ConstructorParameters<typeof Store>[0];
}

describe("Store.linkDiscord — /iam identity-hijack guard", () => {
  it("links a brand-new (unclaimed) rsn — fresh INSERT counts as success", async () => {
    const store = new Store(makeFakeD1());
    const ok = await store.linkDiscord("Zezima", "user1", "Zezima", "user1", "t1");
    expect(ok).toBe(true);

    const row = await store.resolveRsn("Zezima", null);
    expect(row?.discord_user_id).toBe("user1");
  });

  it("blocks a DIFFERENT user from stealing an already-claimed rsn", async () => {
    const store = new Store(makeFakeD1());
    await store.linkDiscord("Zezima", "user1", "Zezima", "user1", "t1");

    const stolen = await store.linkDiscord("Zezima", "user2", "Zezima", "user2", "t2");
    expect(stolen).toBe(false);

    // owner must be unchanged after the blocked attempt
    const row = await store.resolveRsn("Zezima", null);
    expect(row?.discord_user_id).toBe("user1");
  });

  it("still succeeds when the SAME owner re-runs /iam", async () => {
    const store = new Store(makeFakeD1());
    await store.linkDiscord("Zezima", "user1", "Zezima", "user1", "t1");

    const relinked = await store.linkDiscord("Zezima", "user1", "Zezima", "user1", "t2");
    expect(relinked).toBe(true);

    const row = await store.resolveRsn("Zezima", null);
    expect(row?.discord_user_id).toBe("user1");
  });

  it("is case/underscore-insensitive on rsn (canonicalRsn) when detecting ownership conflicts", async () => {
    const store = new Store(makeFakeD1());
    await store.linkDiscord("Lynx Titan", "user1", "Lynx Titan", "user1", "t1");

    const stolen = await store.linkDiscord("lynx_titan", "user2", "lynx_titan", "user2", "t2");
    expect(stolen).toBe(false);
  });
});

describe("Store.vouchedPlayerFor — /dink setup gate", () => {
  it("refuses a row the member created for themselves with /iam", async () => {
    const store = new Store(makeFakeD1());
    await store.linkDiscord("Zezima", "user1", "Zezima", "user1", "t1");
    expect(await store.vouchedPlayerFor("user1")).toBeNull();
  });

  it("passes once an admin /track adds the same rsn (iam first, then track add)", async () => {
    const store = new Store(makeFakeD1());
    await store.linkDiscord("Zezima", "user1", "Zezima", "user1", "t1");
    await store.addPlayer("Zezima", "Zezima", "admin1", "t2"); // INSERT OR IGNORE: no-op
    await store.vouch("Zezima", "admin1");
    expect((await store.vouchedPlayerFor("user1"))?.rsn).toBe("zezima");
  });

  it("passes for a row an admin added and linked to the member", async () => {
    const store = new Store(makeFakeD1());
    await store.addPlayer("Zezima", "Zezima", "admin1", "t1");
    await store.linkDiscord("Zezima", "user1", "Zezima", "admin1", "t1");
    expect((await store.vouchedPlayerFor("user1"))?.rsn).toBe("zezima");
  });
});

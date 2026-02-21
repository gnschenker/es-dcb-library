import { describe, it, expect } from "vitest";
import { query } from "../../src/query/query-object.js";
import {
  compileLoadQuery,
  compileVersionCheckQuery,
  compileStreamQuery,
  compileCanonicalKey,
} from "../../src/query/compiler.js";

describe("compileLoadQuery", () => {

  it("no filter - single clause", () => {
    const q = query.eventsOfType("OrderCreated");
    const { sql, params } = compileLoadQuery(q);
    expect(params).toEqual(["OrderCreated"]);
    expect(sql).toContain("WHERE type = $1");
    expect(sql).toContain("ORDER BY global_position ASC");
    expect(sql).toMatch(/^SELECT global_position, event_id, type, payload, metadata, occurred_at/);
  });

  it("single attr filter", () => {
    const q = query.eventsOfType("OrderCreated").where.key("customerId").equals("c1");
    const { sql, params } = compileLoadQuery(q);
    expect(params[0]).toBe("OrderCreated");
    expect(params[1]).toBe(JSON.stringify({ customerId: "c1" }));
    expect(sql).toContain("WHERE (type = $1 AND payload @> $2::jsonb)");
  });

  it("AND filter - two attributes", () => {
    const q = query.eventsOfType("Order").where.key("a").equals(1).and.key("b").equals(2);
    const { sql, params } = compileLoadQuery(q);
    expect(params[0]).toBe("Order");
    expect(params[1]).toBe(JSON.stringify({ a: 1 }));
    expect(params[2]).toBe(JSON.stringify({ b: 2 }));
    expect(sql).toContain("payload @> $2::jsonb AND payload @> $3::jsonb");
  });

  it("OR filter - two attributes", () => {
    const q = query.eventsOfType("Order").where.key("status").equals("pending").or.key("status").equals("active");
    const { sql, params } = compileLoadQuery(q);
    expect(params[0]).toBe("Order");
    expect(params[1]).toBe(JSON.stringify({ status: "pending" }));
    expect(params[2]).toBe(JSON.stringify({ status: "active" }));
    expect(sql).toContain("payload @> $2::jsonb OR payload @> $3::jsonb");
  });

  it("multi-type - first clause has filter, second does not", () => {
    const q = query.eventsOfType("OrderCreated").where.key("x").equals("v").eventsOfType("OrderShipped");
    const { sql, params } = compileLoadQuery(q);
    expect(params.length).toBe(3);
    expect(params[0]).toBe("OrderCreated");
    expect(params[1]).toBe(JSON.stringify({ x: "v" }));
    expect(params[2]).toBe("OrderShipped");
    expect(sql).toContain("WHERE ((type = $1 AND payload @> $2::jsonb) OR type = $3)");
  });

  it("multi-type - both clauses have filters", () => {
    const q = query.eventsOfType("A").where.key("k").equals("v").eventsOfType("B").where.key("k2").equals("v2");
    const { sql, params } = compileLoadQuery(q);
    expect(params.length).toBe(4);
    expect(params[0]).toBe("A");
    expect(params[1]).toBe(JSON.stringify({ k: "v" }));
    expect(params[2]).toBe("B");
    expect(params[3]).toBe(JSON.stringify({ k2: "v2" }));
    expect(sql).toContain("WHERE ((type = $1 AND payload @> $2::jsonb) OR (type = $3 AND payload @> $4::jsonb))");
  });

  it("parameter numbering - no gaps, no duplicates", () => {
    const q = query.eventsOfType("T").where.key("a").equals(1).and.key("b").equals(2);
    const { sql, params } = compileLoadQuery(q);
    expect(params.length).toBe(3);
    expect(params[0]).toBe("T");
    expect(params[1]).toBe(JSON.stringify({ a: 1 }));
    expect(params[2]).toBe(JSON.stringify({ b: 2 }));
    expect(sql).toContain("$1");
    expect(sql).toContain("$3");
    expect(sql).not.toContain("$4");
  });

  it("value serialization - null, 0, false", () => {
    const cases: Array<[unknown, string]> = [
      [null, JSON.stringify({ key: null })],
      [0, JSON.stringify({ key: 0 })],
      [false, JSON.stringify({ key: false })],
    ];
    for (const [val, expected] of cases) {
      const { params } = compileLoadQuery(query.eventsOfType("T").where.key("key").equals(val));
      expect(params[1]).toBe(expected);
    }
  });

  it("value serialization - nested object", () => {
    const { params } = compileLoadQuery(query.eventsOfType("T").where.key("key").equals({ nested: true }));
    expect(params[1]).toBe(JSON.stringify({ key: { nested: true } }));
  });

});

describe("compileVersionCheckQuery", () => {
  it("starts with COALESCE(MAX(global_position), 0) AS max_pos", () => {
    const { sql } = compileVersionCheckQuery(query.eventsOfType("X"));
    expect(sql).toContain("SELECT COALESCE(MAX(global_position), 0) AS max_pos");
  });

  it("does NOT contain ORDER BY", () => {
    const { sql } = compileVersionCheckQuery(query.eventsOfType("X"));
    expect(sql).not.toContain("ORDER BY");
  });

  it("does NOT contain SELECT global_position, event_id", () => {
    const { sql } = compileVersionCheckQuery(query.eventsOfType("X"));
    expect(sql).not.toContain("SELECT global_position, event_id");
  });

  it("has correct WHERE clause", () => {
    const { sql, params } = compileVersionCheckQuery(query.eventsOfType("MyEvent"));
    expect(params).toEqual(["MyEvent"]);
    expect(sql).toContain("WHERE type = $1");
  });
});

describe("compileStreamQuery", () => {
  it("appends AND global_position and LIMIT", () => {
    const q = query.eventsOfType("OrderCreated");
    const { sql, params } = compileStreamQuery(q, 10n, 50);
    expect(params).toEqual(["OrderCreated", 10n, 50]);
    expect(sql).toContain("AND global_position > $2");
    expect(sql).toContain("LIMIT $3");
    expect(sql).toContain("ORDER BY global_position ASC");
  });

  it("paramOffset shifts param numbering", () => {
    const { sql, params } = compileStreamQuery(query.eventsOfType("X"), 0n, 100, 2);
    expect(params).toEqual(["X", 0n, 100]);
    expect(sql).toContain("type = $3");
    expect(sql).toContain("global_position > $4");
    expect(sql).toContain("LIMIT $5");
  });

  it("contains SELECT columns and FROM events", () => {
    const { sql } = compileStreamQuery(query.eventsOfType("E"), 0n, 10);
    expect(sql).toContain("SELECT global_position, event_id, type, payload, metadata, occurred_at");
    expect(sql).toContain("FROM events");
  });
});

describe("compileCanonicalKey", () => {
  it("same query produces the same key", () => {
    const q1 = query.eventsOfType("OrderCreated").where.key("customerId").equals("c1");
    const q2 = query.eventsOfType("OrderCreated").where.key("customerId").equals("c1");
    expect(compileCanonicalKey(q1)).toBe(compileCanonicalKey(q2));
  });

  it("different type name produces different key", () => {
    expect(compileCanonicalKey(query.eventsOfType("A"))).not.toBe(compileCanonicalKey(query.eventsOfType("B")));
  });

  it("different filter value produces different key", () => {
    const qa = query.eventsOfType("T").where.key("k").equals("v1");
    const qb = query.eventsOfType("T").where.key("k").equals("v2");
    expect(compileCanonicalKey(qa)).not.toBe(compileCanonicalKey(qb));
  });

  it("stable across multiple calls", () => {
    const q = query.eventsOfType("OrderCreated").where.key("customerId").equals("c1");
    const key = compileCanonicalKey(q);
    expect(compileCanonicalKey(q)).toBe(key);
    expect(compileCanonicalKey(q)).toBe(key);
  });

  it("multi-clause queries - clauses sorted alphabetically by type", () => {
    const qAB = query.eventsOfType("A").eventsOfType("B");
    const qBA = query.eventsOfType("B").eventsOfType("A");
    expect(compileCanonicalKey(qAB)).toBe(compileCanonicalKey(qBA));
  });

  it("multi-clause with filters - sorted alphabetically", () => {
    const qXY = query.eventsOfType("X").where.key("id").equals("1").eventsOfType("Y").where.key("id").equals("2");
    const qYX = query.eventsOfType("Y").where.key("id").equals("2").eventsOfType("X").where.key("id").equals("1");
    expect(compileCanonicalKey(qXY)).toBe(compileCanonicalKey(qYX));
  });
});
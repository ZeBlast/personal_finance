import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("the sandbox graph", () => {
  it("is empty at first, then keeps what was saved", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    expect((await t.call("get", "/api/sandbox").expect(200)).body).toBeNull();
    const graph = {
      nodes: [{ id: "a", kind: "income", x: 10, y: 20, params: { amount: 5, period: "yearly" } }],
      wires: [],
      view: { x: 0, y: 0, zoom: 1 },
    };
    await t.call("put", "/api/sandbox").send(graph).expect(204);
    expect((await t.call("get", "/api/sandbox").expect(200)).body).toEqual(graph);
    await t.call("put", "/api/sandbox").send({ nodes: "nope" }).expect(400);
    // The cash-flow map is saved on its own.
    expect((await t.call("get", "/api/sandbox/flow").expect(200)).body).toBeNull();
    const flow = { nodes: [{ id: "pay", kind: "income", amount: 1 }], links: [] };
    await t.call("put", "/api/sandbox/flow").send(flow).expect(204);
    expect((await t.call("get", "/api/sandbox/flow").expect(200)).body).toEqual(flow);
  });

  it("saves named maps of each kind, lists them, loads, renames, overwrites, and deletes them", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const data = { nodes: [{ id: "pay", kind: "income", amount: 1 }], links: [] };
    const made = (
      await t
        .call("post", "/api/sandbox/saves")
        .send({ kind: "flow", name: "  Plan A ", data })
        .expect(201)
    ).body;
    expect(made).toMatchObject({ kind: "flow", name: "Plan A" });
    await t
      .call("post", "/api/sandbox/saves")
      .send({ kind: "math", name: "Maths", data: { nodes: [] } })
      .expect(201);
    // Each kind lists only its own.
    const flows = (await t.call("get", "/api/sandbox/saves?kind=flow").expect(200)).body;
    expect(flows.map((s: { name: string }) => s.name)).toEqual(["Plan A"]);
    expect(flows[0].data).toBeUndefined();
    expect((await t.call("get", `/api/sandbox/saves/${made.id}`).expect(200)).body.data).toEqual(
      data,
    );
    await t.call("put", `/api/sandbox/saves/${made.id}`).send({ name: "Plan B" }).expect(200);
    const changed = { nodes: [], links: [] };
    await t.call("put", `/api/sandbox/saves/${made.id}`).send({ data: changed }).expect(200);
    const loaded = (await t.call("get", `/api/sandbox/saves/${made.id}`).expect(200)).body;
    expect(loaded).toMatchObject({ name: "Plan B", data: changed });
    await t.call("delete", `/api/sandbox/saves/${made.id}`).expect(204);
    await t.call("get", `/api/sandbox/saves/${made.id}`).expect(404);
    // Bad requests.
    await t.call("post", "/api/sandbox/saves").send({ kind: "flow", name: " ", data }).expect(400);
    await t.call("post", "/api/sandbox/saves").send({ kind: "other", name: "x", data }).expect(400);
    await t.call("put", "/api/sandbox/saves/9999").send({ name: "x" }).expect(404);
  });
});

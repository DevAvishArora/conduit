import { describe, expect, it } from "vitest";
import { getPath, render, renderDeep } from "../src/template.js";

const ctx = {
  trigger: { payload: { priority: "high", tags: ["a", "b"], count: 42 } },
  nodes: { http: { status_code: 200, body: { ok: true } } },
};

describe("getPath", () => {
  it("walks dot paths", () => {
    expect(getPath(ctx, "trigger.payload.priority")).toBe("high");
    expect(getPath(ctx, "nodes.http.body.ok")).toBe(true);
  });
  it("handles bracket indexing", () => {
    expect(getPath(ctx, "trigger.payload.tags[1]")).toBe("b");
  });
  it("returns undefined for missing paths", () => {
    expect(getPath(ctx, "trigger.payload.nope")).toBeUndefined();
    expect(getPath(ctx, "nodes.http.body.deep.path")).toBeUndefined();
  });
});

describe("render", () => {
  it("returns the raw value when the whole string is one token", () => {
    expect(render("{{trigger.payload.count}}", ctx)).toBe(42);
    expect(render("{{nodes.http.body}}", ctx)).toEqual({ ok: true });
  });
  it("interpolates within a string", () => {
    expect(render("priority is {{trigger.payload.priority}}", ctx)).toBe("priority is high");
  });
  it("renders objects to JSON inside interpolation", () => {
    expect(render("body={{nodes.http.body}}", ctx)).toBe('body={"ok":true}');
  });
  it("missing path becomes empty string in interpolation", () => {
    expect(render("hi {{nope}}!", ctx)).toBe("hi !");
  });
});

describe("renderDeep", () => {
  it("renders all string fields in a nested object", () => {
    const out = renderDeep(
      {
        url: "https://x/{{trigger.payload.count}}",
        payload: { who: "{{trigger.payload.priority}}" },
      },
      ctx,
    ) as Record<string, unknown>;
    expect(out["url"]).toBe("https://x/42");
    expect((out["payload"] as Record<string, unknown>)["who"]).toBe("high");
  });
});

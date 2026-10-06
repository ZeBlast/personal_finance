import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";
import { defineWidget, type ConfigField } from "./types";

const widgetWith = (
  configFields: ConfigField[],
  defaultConfig: Record<string, string | number | boolean>,
) =>
  defineWidget({
    id: "config-test",
    title: "T",
    description: "d",
    group: "Tools",
    defaultSize: { w: 4, h: 4 },
    configFields,
    defaultConfig,
    Component: () => null,
  });

describe("resolveConfig", () => {
  it("keeps valid values of every type", () => {
    const w = widgetWith(
      [
        {
          key: "s",
          label: "S",
          type: "select",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
        { key: "n", label: "N", type: "number", min: 1, max: 20 },
        { key: "b", label: "B", type: "boolean" },
        { key: "t", label: "T", type: "text", maxLength: 5 },
        { key: "acc", label: "A", type: "account" },
        { key: "cat", label: "C", type: "category" },
      ],
      { s: "a", n: 5, b: false, t: "", acc: "", cat: "" },
    );
    expect(resolveConfig(w, { s: "b", n: 12, b: true, t: "hi", acc: "42", cat: "7" })).toEqual({
      s: "b",
      n: 12,
      b: true,
      t: "hi",
      acc: "42",
      cat: "7",
    });
  });

  it("replaces wrong types with the default", () => {
    const w = widgetWith(
      [
        {
          key: "s",
          label: "S",
          type: "select",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
        { key: "n", label: "N", type: "number", min: 1, max: 20 },
        { key: "b", label: "B", type: "boolean" },
        { key: "acc", label: "A", type: "account" },
      ],
      { s: "b", n: 7, b: true, acc: "3" },
    );
    expect(resolveConfig(w, { s: 5, n: "12", b: "yes", acc: 9 })).toEqual({
      s: "b",
      n: 7,
      b: true,
      acc: "3",
    });
    expect(resolveConfig(w, { s: "zzz", n: Number.NaN, b: null, acc: "not-a-number" })).toEqual({
      s: "b",
      n: 7,
      b: true,
      acc: "3",
    });
    expect(resolveConfig(w, { n: Infinity })).toMatchObject({ n: 7 });
  });

  it("clamps numbers into range and rounds to the step", () => {
    const w = widgetWith([{ key: "n", label: "N", type: "number", min: 3, max: 15 }], { n: 8 });
    expect(resolveConfig(w, { n: 1 })).toEqual({ n: 3 });
    expect(resolveConfig(w, { n: 99 })).toEqual({ n: 15 });
    expect(resolveConfig(w, { n: 7.6 })).toEqual({ n: 8 });
    const stepped = widgetWith(
      [{ key: "n", label: "N", type: "number", min: 0, max: 100, step: 10 }],
      { n: 50 },
    );
    expect(resolveConfig(stepped, { n: 34 })).toEqual({ n: 30 });
    const fractional = widgetWith(
      [{ key: "n", label: "N", type: "number", min: 0, max: 1, step: 0.1 }],
      { n: 0.5 },
    );
    expect(resolveConfig(fractional, { n: 0.35 })).toEqual({ n: 0.35 });
  });

  it("cuts text to its maximum length", () => {
    const w = widgetWith([{ key: "t", label: "T", type: "text", maxLength: 4 }], { t: "" });
    expect(resolveConfig(w, { t: "abcdefgh" })).toEqual({ t: "abcd" });
  });

  it("drops settings the widget does not declare, and fills in ones saved before they existed", () => {
    const w = widgetWith(
      [
        { key: "n", label: "N", type: "number", min: 1, max: 9 },
        { key: "added-later", label: "L", type: "boolean" },
      ],
      { n: 4, "added-later": true },
    );
    expect(resolveConfig(w, { n: 6, removed: "gone", __proto__: { evil: 1 } })).toEqual({
      n: 6,
      "added-later": true,
    });
  });

  it("returns an empty object for a widget with no settings, whatever is stored", () => {
    const w = defineWidget({
      id: "plain-widget",
      title: "T",
      description: "d",
      group: "Tools",
      defaultSize: { w: 4, h: 4 },
      Component: () => null,
    });
    expect(resolveConfig(w, { anything: 1 })).toEqual({});
    expect(resolveConfig(w, null)).toEqual({});
  });

  it("falls back sensibly when even the default is invalid", () => {
    const w = widgetWith(
      [
        {
          key: "s",
          label: "S",
          type: "select",
          options: [
            { value: "first", label: "F" },
            { value: "second", label: "S" },
          ],
        },
        { key: "n", label: "N", type: "number", min: 2, max: 9 },
      ],
      { s: "nope", n: 100 },
    );
    expect(resolveConfig(w, {})).toEqual({ s: "first", n: 9 }); // first option; the default clamped into range
  });
});

import { describe, expect, it } from "vitest";
import { CATALOG_ID } from "./catalog.js";
import { validateA2ui } from "./validate.js";

function surface(components: Record<string, unknown>[], catalogId = CATALOG_ID): unknown[] {
  return [
    { version: "v0.9", createSurface: { surfaceId: "answer", catalogId } },
    { version: "v0.9", updateComponents: { surfaceId: "answer", components } },
  ];
}

describe("validateA2ui", () => {
  it("accepts a line chart and a bar chart", () => {
    const line = validateA2ui(
      surface([
        {
          id: "root",
          component: "LineChart",
          title: "Weight",
          unit: "lb",
          series: [{ name: "Weight", points: [{ label: "Oct 1", value: 180 }, { label: "Oct 2", value: 179.5 }] }],
        },
      ]),
    );
    expect(line.ok).toBe(true);

    const bar = validateA2ui(
      surface([
        { id: "root", component: "Column", children: ["title", "chart"] },
        { id: "title", component: "Text", text: "Today", variant: "title" },
        {
          id: "chart",
          component: "BarChart",
          title: "Macros",
          unit: "g",
          series: [
            { name: "Protein", points: [{ label: "Today", value: 90 }] },
            { name: "Fat", points: [{ label: "Today", value: 60 }] },
            { name: "Carbohydrate", points: [{ label: "Today", value: 180 }] },
            { name: "Fiber", points: [{ label: "Today", value: 25 }] },
          ],
        },
      ]),
    );
    expect(bar.ok).toBe(true);
  });

  it("rejects an unknown component, a dangling child, a non-finite value, and the wrong catalog", () => {
    expect(validateA2ui(surface([{ id: "root", component: "Pie", title: "Nope" }]))).toEqual({
      ok: false,
      message: "Unknown component Pie. Use Column, Text, LineChart, or BarChart.",
    });
    expect(validateA2ui(surface([{ id: "root", component: "Column", children: ["missing"] }]))).toEqual({
      ok: false,
      message: "Column root lists missing child missing.",
    });
    const infinite = validateA2ui(
      surface([
        {
          id: "root",
          component: "LineChart",
          title: "Weight",
          unit: "lb",
          series: [{ name: "Weight", points: [{ label: "Oct 1", value: Number.POSITIVE_INFINITY }] }],
        },
      ]),
    );
    expect(infinite.ok).toBe(false);
    if (!infinite.ok) {
      expect(infinite.message).toContain("Infinity");
    }
    const wrong = validateA2ui(surface([{ id: "root", component: "Text", text: "Hi", variant: "body" }], "https://example.com/other"));
    expect(wrong).toEqual({ ok: false, message: `catalogId must be ${CATALOG_ID}.` });
  });

  it("stamps v0.9 when the messages omit version", () => {
    const result = validateA2ui([
      { createSurface: { surfaceId: "answer", catalogId: CATALOG_ID } },
      {
        updateComponents: {
          surfaceId: "answer",
          components: [{ id: "root", component: "Text", text: "Sep 30", variant: "body" }],
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0].version).toBe("v0.9");
      expect(result.messages[1].version).toBe("v0.9");
      expect(result.messages[1].updateComponents.components[0]).toMatchObject({ text: "Sep 30" });
    }
  });

  it("rejects a version other than v0.9", () => {
    const result = validateA2ui([
      { version: "v0.8", createSurface: { surfaceId: "answer", catalogId: CATALOG_ID } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "answer",
          components: [{ id: "root", component: "Text", text: "Hi", variant: "body" }],
        },
      },
    ]);
    expect(result).toEqual({ ok: false, message: "A2UI messages use version v0.9." });
  });

  it("rejects an extra chart field", () => {
    const extra = validateA2ui(
      surface([
        {
          id: "root",
          component: "BarChart",
          title: "Calories",
          unit: "kcal",
          color: "red",
          series: [{ name: "Calories", points: [{ label: "Mon", value: 1 }] }],
        },
      ]),
    );
    expect(extra.ok).toBe(false);
  });
});

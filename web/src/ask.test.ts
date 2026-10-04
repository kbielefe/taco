/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_ID } from "../../src/ask/catalog.js";

vi.mock("chart.js", () => {
  class Chart {
    static register(): void {}
    destroy = vi.fn();
    constructor(_canvas: unknown, _config: unknown) {}
  }
  return {
    Chart,
    BarController: {},
    BarElement: {},
    CategoryScale: {},
    Legend: {},
    LinearScale: {},
    LineController: {},
    LineElement: {},
    PointElement: {},
    Tooltip: {},
  };
});

import { renderSurface } from "./a2ui.js";
import { assistantMemory } from "./ask.js";

function surface(components: unknown[]): unknown[] {
  return [
    { version: "v0.9", createSurface: { surfaceId: "answer", catalogId: CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId: "answer", components } },
  ];
}

describe("assistantMemory", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("should keep the chart with the spoken line when a surface was shown", () => {
    const host = document.createElement("div");
    renderSurface(
      host,
      surface([
        { id: "root", component: "Column", children: ["title", "chart", "note"] },
        { id: "title", component: "Text", text: "First moderate or severe migraine", variant: "title" },
        {
          id: "chart",
          component: "BarChart",
          title: "Hour of day (Chicago)",
          unit: "days",
          series: [{ name: "Days", points: [{ label: "6", value: 1 }, { label: "10", value: 3 }] }],
        },
        { id: "note", component: "Text", text: "One count per day.", variant: "body" },
      ]),
    );
    const memory = assistantMemory("Shown above.", host);
    expect(memory).toContain("Shown above.");
    expect(memory).toContain("First moderate or severe migraine");
    expect(memory).toContain("Hour of day (Chicago)");
    expect(memory).toContain("One count per day.");
    expect(memory).toContain("6 1");
    expect(memory).toContain("10 3");
    expect(memory).not.toBe("Shown above.");
  });

  it("should say a chart was shown when the turn has no sentence and no surface", () => {
    expect(assistantMemory("  ", document.createElement("div"))).toBe("Shown a chart.");
  });
});

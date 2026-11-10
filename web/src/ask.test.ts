/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { mountAsk, savedGraphLabel, assistantMemory } from "./ask.js";

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

describe("saved graphs", () => {
  const now = new Date(2026, 10, 9, 18, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    document.body.innerHTML = `
      <div id="ask-saved" class="field" hidden>
        <label for="ask-graphs">Saved graphs</label>
        <select id="ask-graphs"></select>
      </div>
      <div id="ask-log"><p id="ask-empty" class="empty">This conversation stays in the tab until you refresh.</p></div>
      <form id="ask-form">
        <p id="ask-error" hidden></p>
        <input id="ask-question" />
        <button id="ask-button" type="submit">Ask</button>
        <p id="ask-status"></p>
      </form>
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("labels a saved graph with its caption and age", () => {
    expect(savedGraphLabel("Migraines per week", new Date(2026, 10, 7, 9, 0, 0), now)).toBe(
      "Migraines per week    2 days ago",
    );
  });

  it("hides the menu when nothing is saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ graphs: [] })),
    );
    await mountAsk().loadGraphs();
    expect(document.querySelector<HTMLElement>("#ask-saved")?.hidden).toBe(true);
  });

  it("lists saved graphs newest first and draws the chosen chart", async () => {
    const messages = surface([
      {
        id: "root",
        component: "LineChart",
        title: "Migraines per week",
        unit: "days",
        series: [{ name: "Days", points: [{ label: "Mon", value: 2 }] }],
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/ask/graphs") {
          return Response.json({
            graphs: [
              { id: "older-id", caption: "Migraines per week", createdAt: new Date(2026, 10, 7, 12).toISOString() },
              { id: "newer-id", caption: "Weight", createdAt: new Date(2026, 10, 8, 12).toISOString() },
            ],
          });
        }
        if (url === "/api/ask/graphs/older-id") {
          return Response.json({ id: "older-id", caption: "Migraines per week", messages });
        }
        throw new Error(`Unexpected ${url}`);
      }),
    );
    await mountAsk().loadGraphs();
    const select = document.querySelector<HTMLSelectElement>("#ask-graphs");
    expect(document.querySelector<HTMLElement>("#ask-saved")?.hidden).toBe(false);
    expect([...select!.options].map((option) => option.textContent)).toEqual([
      "Choose a graph",
      "Weight    1 day ago",
      "Migraines per week    2 days ago",
    ]);
    select!.value = "older-id";
    select!.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.querySelector("figcaption")?.textContent).toBe("Migraines per week");
    });
    expect(document.querySelector<HTMLElement>("#ask-empty")?.hidden).toBe(true);
  });
});

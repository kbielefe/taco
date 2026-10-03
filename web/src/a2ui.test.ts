/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_ID } from "../../src/ask/catalog.js";

interface MadeChart {
  destroy: ReturnType<typeof vi.fn>;
  config: {
    type?: string;
    data?: { datasets?: Array<{ label?: string; backgroundColor?: string; data?: Array<number | null> }> };
  };
}

vi.mock("chart.js", () => {
  class Chart {
    static made: MadeChart[] = [];
    static register(): void {}
    destroy = vi.fn();
    config: MadeChart["config"];
    constructor(_canvas: unknown, config: MadeChart["config"]) {
      this.config = config;
      Chart.made.push(this);
    }
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

import { Chart } from "chart.js";
import { releaseSurface, renderSurface } from "./a2ui.js";

function made(): MadeChart[] {
  return (Chart as unknown as { made: MadeChart[] }).made;
}

function surface(components: unknown[], catalogId = CATALOG_ID): unknown[] {
  return [
    { version: "v0.9", createSurface: { surfaceId: "answer", catalogId } },
    { version: "v0.9", updateComponents: { surfaceId: "answer", components } },
  ];
}

describe("renderSurface", () => {
  beforeEach(() => {
    made().length = 0;
    document.body.replaceChildren();
    document.documentElement.style.setProperty("--protein", "#9a3412");
    document.documentElement.style.setProperty("--fg", "#1c1917");
    document.documentElement.style.setProperty("--muted", "#57534e");
    document.documentElement.style.setProperty("--border", "#e4ddd4");
  });

  it("draws a line chart and a table of the same numbers", () => {
    const host = document.createElement("div");
    document.body.append(host);
    renderSurface(
      host,
      surface([
        {
          id: "root",
          component: "LineChart",
          title: "Calories",
          unit: "kcal",
          series: [{ name: "Calories", points: [{ label: "Mon", value: 1800 }, { label: "Tue", value: 1900 }] }],
        },
      ]),
    );
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(host.querySelector("figcaption")?.textContent).toBe("Calories");
    expect(host.querySelector("td")?.textContent).toBe("1800");
    expect(made()[0]?.config.type).toBe("line");
    expect(made()[0]?.config.data?.datasets?.[0]?.data).toEqual([1800, 1900]);
  });

  it("uses the protein color and keeps markup as text", () => {
    const host = document.createElement("div");
    renderSurface(
      host,
      surface([
        { id: "root", component: "Column", children: ["title", "chart"] },
        { id: "title", component: "Text", text: "<img src=x>", variant: "title" },
        {
          id: "chart",
          component: "BarChart",
          title: "Today",
          unit: "g",
          series: [{ name: "Protein", points: [{ label: "Today", value: 90 }] }],
        },
      ]),
    );
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x>");
    expect(made()[0]?.config.data?.datasets?.[0]?.backgroundColor).toBe("#9a3412");
  });

  it("keeps the rest of a surface when one component is unknown", () => {
    const host = document.createElement("div");
    renderSurface(
      host,
      surface([
        { id: "root", component: "Column", children: ["label", "mystery"] },
        { id: "label", component: "Text", text: "Weight", variant: "title" },
        { id: "mystery", component: "Widget" },
      ]),
    );
    expect(host.textContent).toContain("Weight");
    expect(host.textContent).toContain("This part could not be displayed.");
    expect(made()).toHaveLength(0);
  });

  it("skips a surface for a different catalog and destroys the previous chart", () => {
    const host = document.createElement("div");
    renderSurface(
      host,
      surface([
        {
          id: "root",
          component: "LineChart",
          title: "Calories",
          unit: "kcal",
          series: [{ name: "Calories", points: [{ label: "Mon", value: 1 }] }],
        },
      ]),
    );
    const first = made()[0];
    renderSurface(host, surface([{ id: "root", component: "Text", text: "Hi", variant: "body" }], "https://example.com/no"));
    expect(first?.destroy).toHaveBeenCalled();
    expect(host.querySelector("canvas")).toBeNull();
    expect(host.textContent).toContain("This chart could not be displayed.");
    releaseSurface(host);
  });
});

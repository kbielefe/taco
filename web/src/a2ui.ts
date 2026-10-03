import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from "chart.js";
import { CATALOG_ID } from "../../src/ask/catalog.js";

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
);

const MACRO_TOKENS: Record<string, string> = {
  protein: "--protein",
  fat: "--fat",
  carbohydrate: "--carb",
  fiber: "--fiber",
};

const SERIES_TOKENS = ["--accent", "--protein", "--fat", "--carb"];

interface ChartPoint {
  label: string;
  value: number;
}

interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

type LooseComponent =
  | { id: string; kind: "column"; children: string[] }
  | { id: string; kind: "text"; text: string; variant: "title" | "body" }
  | { id: string; kind: "chart"; chart: "line" | "bar"; title: string; unit: string; series: ChartSeries[] }
  | { id: string; kind: "unknown" };

const surfaces = new Map<HTMLElement, unknown[]>();
const charts = new Map<HTMLElement, Chart[]>();

const colorScheme = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : undefined;
colorScheme?.addEventListener("change", () => {
  for (const [host, messages] of surfaces) {
    if (host.isConnected) {
      paint(host, messages);
    } else {
      releaseSurface(host);
    }
  }
});

export function renderSurface(host: HTMLElement, messages: unknown[]): void {
  surfaces.set(host, messages);
  paint(host, messages);
}

export function releaseSurface(host: HTMLElement): void {
  destroyCharts(host);
  surfaces.delete(host);
}

function paint(host: HTMLElement, messages: unknown[]): void {
  destroyCharts(host);
  host.replaceChildren();
  const read = readSurface(messages);
  if (!read.catalogOk) {
    host.append(note("This chart could not be displayed."));
    return;
  }
  if (!read.components.has("root")) {
    return;
  }
  const created: Chart[] = [];
  draw(host, "root", read.components, new Set(), created);
  if (created.length > 0) {
    charts.set(host, created);
  }
}

function draw(
  parent: HTMLElement,
  id: string,
  components: Map<string, LooseComponent>,
  seen: Set<string>,
  created: Chart[],
): void {
  if (seen.has(id)) {
    return;
  }
  seen.add(id);
  const component = components.get(id);
  if (!component || component.kind === "unknown") {
    parent.append(note("This part could not be displayed."));
    return;
  }
  if (component.kind === "column") {
    const stack = document.createElement("div");
    stack.className = "ask-stack";
    parent.append(stack);
    for (const child of component.children) {
      draw(stack, child, components, seen, created);
    }
    return;
  }
  if (component.kind === "text") {
    const node = document.createElement(component.variant === "title" ? "h2" : "p");
    node.className = component.variant === "title" ? "ask-title" : "ask-body";
    node.textContent = component.text;
    parent.append(node);
    return;
  }
  parent.append(drawChart(component, created));
}

function drawChart(component: Extract<LooseComponent, { kind: "chart" }>, created: Chart[]): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "ask-chart";
  const caption = document.createElement("figcaption");
  caption.textContent = component.title;
  const frame = document.createElement("div");
  frame.className = "ask-chart-canvas";
  const canvas = document.createElement("canvas");
  frame.append(canvas);
  figure.append(caption, frame, dataTable(component));
  try {
    created.push(new Chart(canvas, chartConfig(component)));
  } catch {
    frame.replaceChildren(note("This part could not be displayed."));
  }
  return figure;
}

function chartConfig(component: Extract<LooseComponent, { kind: "chart" }>): ChartConfiguration<"line" | "bar"> {
  const theme = readTheme();
  const labels = labelsOf(component.series);
  return {
    type: component.chart,
    data: {
      labels,
      datasets: component.series.map((series, index) => {
        const ink = seriesColor(series.name, index);
        const values = labels.map((label) => series.points.find((point) => point.label === label)?.value ?? null);
        return {
          label: series.name,
          data: values,
          borderColor: ink,
          backgroundColor: ink,
          pointBackgroundColor: ink,
          tension: 0.2,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: component.series.length > 1,
          labels: { color: theme.fg },
        },
      },
      scales: {
        x: {
          ticks: { color: theme.muted, autoSkip: true, maxRotation: 0, minRotation: 0 },
          grid: { color: theme.border },
        },
        y: {
          beginAtZero: component.chart === "bar",
          ticks: { color: theme.muted },
          grid: { color: theme.border },
          title: {
            display: component.unit.length > 0,
            text: component.unit,
            color: theme.muted,
          },
        },
      },
    },
  };
}

function dataTable(component: Extract<LooseComponent, { kind: "chart" }>): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "visually-hidden";
  const caption = document.createElement("caption");
  caption.textContent = component.unit ? `${component.title} (${component.unit})` : component.title;
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Label", ...component.series.map((series) => series.name)]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    cell.scope = "col";
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const label of labelsOf(component.series)) {
    const row = document.createElement("tr");
    const rowHeader = document.createElement("th");
    rowHeader.scope = "row";
    rowHeader.textContent = label;
    row.append(rowHeader);
    for (const series of component.series) {
      const cell = document.createElement("td");
      const point = series.points.find((item) => item.label === label);
      cell.textContent = point ? String(point.value) : "";
      row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, head, body);
  return table;
}

function readSurface(messages: unknown[]): { catalogOk: boolean; components: Map<string, LooseComponent> } {
  let catalogOk = true;
  const components = new Map<string, LooseComponent>();
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const created = message.createSurface;
    if (isRecord(created) && created.catalogId !== CATALOG_ID) {
      catalogOk = false;
    }
    const updated = message.updateComponents;
    if (!isRecord(updated) || !Array.isArray(updated.components)) {
      continue;
    }
    for (const raw of updated.components) {
      const component = readComponent(raw);
      if (component) {
        components.set(component.id, component);
      }
    }
  }
  return { catalogOk, components };
}

function readComponent(value: unknown): LooseComponent | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return undefined;
  }
  if (value.component === "Column" && Array.isArray(value.children)) {
    return { id: value.id, kind: "column", children: value.children.filter((child): child is string => typeof child === "string") };
  }
  if (value.component === "Text" && typeof value.text === "string") {
    const variant = value.variant === "title" ? "title" : "body";
    return { id: value.id, kind: "text", text: value.text, variant };
  }
  if (value.component === "LineChart" || value.component === "BarChart") {
    const series = readSeries(value.series);
    if (!series || typeof value.title !== "string") {
      return { id: value.id, kind: "unknown" };
    }
    return {
      id: value.id,
      kind: "chart",
      chart: value.component === "LineChart" ? "line" : "bar",
      title: value.title,
      unit: typeof value.unit === "string" ? value.unit : "",
      series,
    };
  }
  return { id: value.id, kind: "unknown" };
}

function readSeries(value: unknown): ChartSeries[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const series: ChartSeries[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || !Array.isArray(item.points)) {
      continue;
    }
    const points: ChartPoint[] = [];
    for (const point of item.points) {
      if (!isRecord(point) || typeof point.label !== "string" || typeof point.value !== "number" || !Number.isFinite(point.value)) {
        continue;
      }
      points.push({ label: point.label, value: point.value });
    }
    if (points.length > 0) {
      series.push({ name: item.name, points });
    }
  }
  return series.length > 0 ? series : undefined;
}

function labelsOf(series: ChartSeries[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of series) {
    for (const point of item.points) {
      if (!seen.has(point.label)) {
        seen.add(point.label);
        labels.push(point.label);
      }
    }
  }
  return labels;
}

function seriesColor(name: string, index: number): string {
  const tokenName = MACRO_TOKENS[name.trim().toLowerCase()] ?? SERIES_TOKENS[index % SERIES_TOKENS.length] ?? "--accent";
  return token(tokenName) || "#0f766e";
}

function readTheme(): { fg: string; muted: string; border: string } {
  return {
    fg: token("--fg") || "#1c1917",
    muted: token("--muted") || "#57534e",
    border: token("--border") || "#e4ddd4",
  };
}

function token(name: string): string {
  const computed = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (computed) {
    return computed;
  }
  return document.documentElement.style.getPropertyValue(name).trim();
}

function note(text: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.className = "ask-fallback";
  node.textContent = text;
  return node;
}

function destroyCharts(host: HTMLElement): void {
  for (const chart of charts.get(host) ?? []) {
    chart.destroy();
  }
  charts.delete(host);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

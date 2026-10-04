import { z } from "zod";
import { CATALOG_ID, MAX_COMPONENTS, MAX_POINTS, MAX_SERIES } from "./catalog.js";

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

const pointSchema = z.strictObject({
  label: z.string().trim().min(1, "Each point needs a label.").max(80, "Point labels must be 80 characters or fewer."),
  value: z.number().finite("Point values must be finite numbers."),
});

const seriesSchema = z.strictObject({
  name: z.string().trim().min(1, "Each series needs a name.").max(80, "Series names must be 80 characters or fewer."),
  points: z
    .array(pointSchema)
    .min(1, "Each series needs a point.")
    .max(MAX_POINTS, `A series can have at most ${MAX_POINTS} points.`),
});

const chartSchema = z.strictObject({
  title: z.string().trim().min(1, "A chart needs a title.").max(120, "Chart titles must be 120 characters or fewer."),
  unit: z.string().trim().max(40, "The unit must be 40 characters or fewer."),
  series: z.array(seriesSchema).min(1, "A chart needs a series.").max(MAX_SERIES, `A chart can have at most ${MAX_SERIES} series.`),
});

const textSchema = z.strictObject({
  text: z.string().trim().min(1, "Text needs text.").max(500, "Text must be 500 characters or fewer."),
  variant: z.enum(["title", "body"], { error: "Text variant must be title or body." }),
});

const columnSchema = z.strictObject({
  children: z
    .array(z.string().regex(ID_PATTERN, "Child ids must be short names."))
    .min(1, "Column needs a child.")
    .max(MAX_COMPONENTS, `A column can have at most ${MAX_COMPONENTS} children.`),
});

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

export interface ChartProps {
  title: string;
  unit: string;
  series: ChartSeries[];
}

export type A2uiComponent =
  | { id: string; component: "Column"; children: string[] }
  | { id: string; component: "Text"; text: string; variant: "title" | "body" }
  | { id: string; component: "LineChart"; title: string; unit: string; series: ChartSeries[] }
  | { id: string; component: "BarChart"; title: string; unit: string; series: ChartSeries[] };

export interface A2uiCreateMessage {
  version: "v0.9";
  createSurface: { surfaceId: string; catalogId: string };
}

export interface A2uiUpdateMessage {
  version: "v0.9";
  updateComponents: { surfaceId: string; components: A2uiComponent[] };
}

export type A2uiMessage = A2uiCreateMessage | A2uiUpdateMessage;

export type A2uiValidation = { ok: true; messages: [A2uiCreateMessage, A2uiUpdateMessage] } | { ok: false; message: string };

export function validateA2ui(input: unknown): A2uiValidation {
  if (!Array.isArray(input) || input.length !== 2) {
    return fail("Send two messages: createSurface, then updateComponents.");
  }
  const created = readCreate(input[0]);
  if (typeof created === "string") {
    return fail(created);
  }
  const updated = readUpdate(input[1], created.createSurface.surfaceId);
  if (typeof updated === "string") {
    return fail(updated);
  }
  return { ok: true, messages: [created, updated] };
}

function readCreate(value: unknown): A2uiCreateMessage | string {
  const record = messageRecord(value);
  if (typeof record === "string") {
    return record;
  }
  if (!("createSurface" in record) || "updateComponents" in record) {
    return "The first message must be createSurface.";
  }
  const surface = record.createSurface;
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    return "createSurface must be an object.";
  }
  const body = surface as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "surfaceId" && key !== "catalogId")) {
    return "createSurface only accepts surfaceId and catalogId.";
  }
  if (typeof body.surfaceId !== "string" || !ID_PATTERN.test(body.surfaceId)) {
    return "surfaceId must be a short name.";
  }
  if (body.catalogId !== CATALOG_ID) {
    return `catalogId must be ${CATALOG_ID}.`;
  }
  return {
    version: "v0.9",
    createSurface: { surfaceId: body.surfaceId, catalogId: CATALOG_ID },
  };
}

function readUpdate(value: unknown, surfaceId: string): A2uiUpdateMessage | string {
  const record = messageRecord(value);
  if (typeof record === "string") {
    return record;
  }
  if (!("updateComponents" in record) || "createSurface" in record) {
    return "The second message must be updateComponents.";
  }
  const update = record.updateComponents;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return "updateComponents must be an object.";
  }
  const body = update as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "surfaceId" && key !== "components")) {
    return "updateComponents only accepts surfaceId and components.";
  }
  if (body.surfaceId !== surfaceId) {
    return "Use the same surfaceId on both messages.";
  }
  if (!Array.isArray(body.components) || body.components.length === 0) {
    return "updateComponents needs at least one component.";
  }
  if (body.components.length > MAX_COMPONENTS) {
    return `A surface can have at most ${MAX_COMPONENTS} components.`;
  }
  const components: A2uiComponent[] = [];
  const seen = new Set<string>();
  for (const raw of body.components) {
    const component = readComponent(raw);
    if (typeof component === "string") {
      return component;
    }
    if (seen.has(component.id)) {
      return `Component id ${component.id} is repeated.`;
    }
    seen.add(component.id);
    components.push(component);
  }
  if (!seen.has("root")) {
    return "Add a component with id root.";
  }
  const byId = new Map(components.map((component) => [component.id, component]));
  for (const component of components) {
    if (component.component !== "Column") {
      continue;
    }
    for (const child of component.children) {
      if (!byId.has(child)) {
        return `Column ${component.id} lists missing child ${child}.`;
      }
    }
  }
  const cycle = findCycle("root", byId, []);
  if (cycle) {
    return cycle;
  }
  return { version: "v0.9", updateComponents: { surfaceId, components } };
}

function readComponent(value: unknown): A2uiComponent | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Each component must be an object.";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) {
    return "Each component id must be a short name.";
  }
  const props = { ...record };
  delete props.id;
  delete props.component;
  if (record.component === "Column") {
    const parsed = columnSchema.safeParse(props);
    if (!parsed.success) {
      return issue(parsed.error, `Column ${record.id}`);
    }
    if (new Set(parsed.data.children).size !== parsed.data.children.length) {
      return `Column ${record.id} repeats a child.`;
    }
    return { id: record.id, component: "Column", children: parsed.data.children };
  }
  if (record.component === "Text") {
    const parsed = textSchema.safeParse(props);
    if (!parsed.success) {
      return issue(parsed.error, `Text ${record.id}`);
    }
    return { id: record.id, component: "Text", text: parsed.data.text, variant: parsed.data.variant };
  }
  if (record.component === "LineChart" || record.component === "BarChart") {
    const parsed = chartSchema.safeParse(props);
    if (!parsed.success) {
      return issue(parsed.error, `${record.component} ${record.id}`);
    }
    for (const series of parsed.data.series) {
      const labels = series.points.map((point) => point.label);
      if (new Set(labels).size !== labels.length) {
        return `Series ${series.name} repeats a label.`;
      }
    }
    return { id: record.id, component: record.component, ...parsed.data };
  }
  const name = typeof record.component === "string" ? record.component : "component";
  return `Unknown component ${name}. Use Column, Text, LineChart, or BarChart.`;
}

function messageRecord(value: unknown): Record<string, unknown> | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Each A2UI message must be an object.";
  }
  const record = value as Record<string, unknown>;
  // A missing version is v0.9. The readers stamp it onto the messages the page draws.
  if (record.version !== undefined && record.version !== "v0.9") {
    return "A2UI messages use version v0.9.";
  }
  const keys = Object.keys(record).filter((key) => key !== "version");
  if (keys.length !== 1) {
    return "Each message is createSurface or updateComponents.";
  }
  return record;
}

function findCycle(id: string, byId: Map<string, A2uiComponent>, trail: string[]): string | undefined {
  if (trail.includes(id)) {
    return `Components refer to themselves: ${[...trail, id].join(" -> ")}.`;
  }
  const component = byId.get(id);
  if (!component || component.component !== "Column") {
    return undefined;
  }
  for (const child of component.children) {
    const cycle = findCycle(child, byId, [...trail, id]);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

function issue(error: z.ZodError, label: string): string {
  return `${label}: ${error.issues[0]?.message ?? "Check the fields."}`;
}

function fail(message: string): A2uiValidation {
  return { ok: false, message };
}

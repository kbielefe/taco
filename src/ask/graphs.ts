import { randomUUID } from "node:crypto";
import type { CacheStore } from "../fdc/cache.js";
import { validateA2ui, type A2uiMessage } from "./validate.js";

export const ASK_GRAPH_CACHE_SOURCE = "ask-graph";
export const GRAPH_CACHE_PREFIX = "ask-graph:v1:";
/** Shown charts stay available for one year. */
export const GRAPH_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const GRAPH_LIST_LIMIT = 100;

const GRAPH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SavedGraphSummary {
  id: string;
  caption: string;
  createdAt: Date;
}

export interface SavedGraph {
  id: string;
  caption: string;
  messages: A2uiMessage[];
}

export function graphCacheKey(id: string): string {
  return `${GRAPH_CACHE_PREFIX}${id}`;
}

/** The chart title, which is the short caption in the saved-graph menu. */
export function graphCaption(messages: readonly A2uiMessage[]): string | undefined {
  for (const message of messages) {
    if (!("updateComponents" in message)) {
      continue;
    }
    for (const component of message.updateComponents.components) {
      if (component.component !== "LineChart" && component.component !== "BarChart") {
        continue;
      }
      const title = component.title.replace(/\s+/g, " ").trim();
      if (title !== "") {
        return title;
      }
    }
  }
  return undefined;
}

export class GraphCache {
  constructor(private readonly store: CacheStore) {}

  async remember(messages: readonly A2uiMessage[]): Promise<string | undefined> {
    const validated = validateA2ui([...messages]);
    if (!validated.ok) {
      return undefined;
    }
    const caption = graphCaption(validated.messages);
    if (!caption) {
      return undefined;
    }
    const id = randomUUID();
    await this.store.set(graphCacheKey(id), { caption, messages: validated.messages }, GRAPH_CACHE_TTL_MS);
    return id;
  }

  async list(): Promise<SavedGraphSummary[]> {
    const entries = await this.store.listRecent({ keyPrefix: GRAPH_CACHE_PREFIX, limit: GRAPH_LIST_LIMIT });
    const graphs: SavedGraphSummary[] = [];
    for (const entry of entries) {
      const id = entry.key.startsWith(GRAPH_CACHE_PREFIX) ? entry.key.slice(GRAPH_CACHE_PREFIX.length) : "";
      const stored = GRAPH_ID.test(id) ? readStored(entry.value) : undefined;
      if (!stored) {
        continue;
      }
      graphs.push({ id, caption: stored.caption, createdAt: entry.createdAt });
    }
    graphs.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return graphs;
  }

  async get(id: string): Promise<SavedGraph | undefined> {
    if (!GRAPH_ID.test(id)) {
      return undefined;
    }
    const stored = readStored(await this.store.get(graphCacheKey(id)));
    if (!stored) {
      return undefined;
    }
    return { id, caption: stored.caption, messages: stored.messages };
  }
}

function readStored(value: unknown): { caption: string; messages: A2uiMessage[] } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { caption?: unknown; messages?: unknown };
  if (typeof record.caption !== "string") {
    return undefined;
  }
  const caption = record.caption.replace(/\s+/g, " ").trim();
  const validated = validateA2ui(record.messages);
  if (caption === "" || !validated.ok || graphCaption(validated.messages) === undefined) {
    return undefined;
  }
  return { caption, messages: validated.messages };
}

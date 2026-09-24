import { Buffer } from "node:buffer";
import type { Document } from "mongodb";
import { MAX_AGGREGATE_DOCUMENTS, READ_COLLECTIONS, type DataCatalog, type ReadCollection } from "./catalog.js";
import { encodeExtendedJson } from "./ejson.js";
import { McpQueryError, prepareAggregate, prepareCollection, prepareCount, prepareFind, prepareSample, readToolArguments } from "./query.js";
import { collectionDescription, inferFields } from "./schema.js";

const SCHEMA_SORT: Record<ReadCollection, Document> = {
  food: { eatenAt: -1 },
  observations: { at: -1 },
  kinds: { createdAt: -1 },
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: true;
  };
}

export interface ToolTextResult {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const COLLECTION_PROPERTY = {
  type: "string",
  enum: [...READ_COLLECTIONS],
  description: "Collection in the health database. food is logged meals, observations is journal entries, and kinds is the journal schema.",
};

const FILTER_PROPERTY = {
  type: "object",
  description:
    'MongoDB filter in Extended JSON. Dates are {"$date":"<ISO-8601>"} and ObjectIds are {"$oid":"<24 hex chars>"}.',
};

const BYTE_LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Maximum response bytes. The server caps this and drops whole documents until the payload fits.",
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "list-collections",
    description: "List the collections this endpoint can read, with the shape of each document.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "collection-schema",
    description:
      "Describe one collection and infer field types from a sample of its newest documents. Modeled on the MongoDB MCP collection-schema tool.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_PROPERTY,
        sampleSize: {
          type: "integer",
          minimum: 1,
          description: "How many recent documents to sample. Default 20, maximum 100.",
        },
        responseBytesLimit: BYTE_LIMIT_PROPERTY,
      },
      required: ["collection"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "collection-indexes",
    description: "List indexes for one collection. Modeled on the MongoDB MCP collection-indexes tool.",
    inputSchema: {
      type: "object",
      properties: { collection: COLLECTION_PROPERTY },
      required: ["collection"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "find",
    description:
      "Run a find against food, observations, or kinds. Modeled on the MongoDB MCP find tool. Default limit is 20 and the maximum is 100.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_PROPERTY,
        filter: FILTER_PROPERTY,
        projection: { type: "object", description: "MongoDB projection. Example: { items: 0 }." },
        sort: { type: "object", description: 'Sort specification. Example: { "eatenAt": -1 }.' },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum documents. Default 20, maximum 100." },
        skip: { type: "integer", minimum: 0, description: "Documents to skip. Maximum 10000." },
        responseBytesLimit: BYTE_LIMIT_PROPERTY,
      },
      required: ["collection"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "aggregate",
    description:
      "Run an aggregation pipeline against one collection. Modeled on the MongoDB MCP aggregate tool. $out, $merge, $lookup, $unionWith, $graphLookup, and server-side JavaScript are rejected. At most 100 result documents are returned.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_PROPERTY,
        pipeline: {
          type: "array",
          description: "Aggregation stages. A $match on a date uses {\"$date\":\"<ISO-8601>\"}.",
          items: { type: "object" },
        },
        responseBytesLimit: BYTE_LIMIT_PROPERTY,
      },
      required: ["collection", "pipeline"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "count",
    description: "Count documents in one collection. The filter matches countDocuments. Modeled on the MongoDB MCP count tool.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_PROPERTY,
        filter: FILTER_PROPERTY,
        query: FILTER_PROPERTY,
      },
      required: ["collection"],
    },
    annotations: READ_ONLY,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function listTools(): ToolDefinition[] {
  return TOOLS;
}

export async function callTool(name: string, rawArguments: unknown, catalog: DataCatalog): Promise<ToolTextResult> {
  if (!TOOL_BY_NAME.has(name)) {
    return errorResult(`Unknown tool ${name}.`);
  }
  try {
    const args = readToolArguments(rawArguments);
    const payload = await dispatch(name, args, catalog);
    return { content: [{ type: "text", text: payload }] };
  } catch (error) {
    if (error instanceof McpQueryError) {
      return errorResult(error.message);
    }
    const message = error instanceof Error ? error.message : "The query failed.";
    return errorResult(message);
  }
}

async function dispatch(name: string, args: Record<string, unknown>, catalog: DataCatalog): Promise<string> {
  switch (name) {
    case "list-collections":
      return encodeExtendedJson({
        database: "health",
        collections: READ_COLLECTIONS.map((collection) => ({
          name: collection,
          description: collectionDescription(collection),
        })),
      });
    case "collection-schema": {
      const sample = prepareSample(args);
      const documents = await catalog.find(sample.collection, {}, { sort: SCHEMA_SORT[sample.collection], limit: sample.sampleSize, skip: 0 });
      return fitPayload(
        {
          collection: sample.collection,
          description: collectionDescription(sample.collection),
          sampled: documents.length,
          fields: inferFields(documents),
        },
        sample.responseBytesLimit,
      );
    }
    case "collection-indexes": {
      const collection = prepareCollection(args);
      const indexes = await catalog.indexes(collection);
      return encodeExtendedJson({ collection, indexes });
    }
    case "find": {
      const query = prepareFind(args);
      const documents = await catalog.find(query.collection, query.filter, {
        ...(query.projection ? { projection: query.projection } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        limit: query.limit,
        skip: query.skip,
      });
      return fitDocuments(documents, query.responseBytesLimit, { collection: query.collection });
    }
    case "aggregate": {
      const query = prepareAggregate(args);
      const documents = await catalog.aggregate(query.collection, query.pipeline);
      const capped = documents.length > MAX_AGGREGATE_DOCUMENTS;
      const kept = capped ? documents.slice(0, MAX_AGGREGATE_DOCUMENTS) : documents;
      return fitDocuments(kept, query.responseBytesLimit, {
        collection: query.collection,
        ...(capped ? { truncated: true, message: `Aggregation stopped after ${MAX_AGGREGATE_DOCUMENTS} documents.` } : {}),
      });
    }
    case "count": {
      const query = prepareCount(args);
      const count = await catalog.count(query.collection, query.filter);
      return encodeExtendedJson({ collection: query.collection, count });
    }
    default:
      throw new McpQueryError(`Unknown tool ${name}.`);
  }
}

function fitDocuments(documents: Document[], byteLimit: number, meta: Record<string, unknown>): string {
  let count = documents.length;
  let truncated = false;
  while (true) {
    const payload = {
      ...meta,
      returned: count,
      ...(truncated ? { truncated: true } : {}),
      documents: documents.slice(0, count),
    };
    const text = encodeExtendedJson(payload);
    if (Buffer.byteLength(text, "utf8") <= byteLimit) {
      return text;
    }
    if (count === 0) {
      return encodeExtendedJson({
        ...meta,
        returned: 0,
        truncated: true,
        documents: [],
        message: "A single document exceeded the response byte limit. Use a projection.",
      });
    }
    truncated = true;
    count -= 1;
  }
}

function fitPayload(payload: Record<string, unknown>, byteLimit: number): string {
  const text = encodeExtendedJson(payload);
  if (Buffer.byteLength(text, "utf8") <= byteLimit) {
    return text;
  }
  return encodeExtendedJson({
    collection: payload.collection,
    description: payload.description,
    sampled: payload.sampled,
    truncated: true,
    message: "The inferred schema exceeded the response byte limit. Lower sampleSize.",
  });
}

function errorResult(message: string): ToolTextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

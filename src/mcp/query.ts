import type { Document } from "mongodb";
import {
  DEFAULT_LIMIT,
  DEFAULT_RESPONSE_BYTES,
  DEFAULT_SAMPLE_SIZE,
  MAX_LIMIT,
  MAX_RESPONSE_BYTES,
  MAX_SAMPLE_SIZE,
  MAX_SKIP,
  isReadCollection,
  type ReadCollection,
} from "./catalog.js";
import { decodeExtendedJson } from "./ejson.js";

const MAX_DEPTH = 40;
const MAX_PIPELINE_STAGES = 20;

const FORBIDDEN_OPERATORS = new Set([
  "$accumulator",
  "$changeStream",
  "$currentOp",
  "$function",
  "$graphLookup",
  "$listLocalSessions",
  "$listSessions",
  "$lookup",
  "$merge",
  "$out",
  "$queryStats",
  "$unionWith",
  "$where",
]);

export class McpQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpQueryError";
  }
}

export interface PreparedFind {
  collection: ReadCollection;
  filter: Document;
  projection?: Document;
  sort?: Document;
  limit: number;
  skip: number;
  responseBytesLimit: number;
}

export interface PreparedAggregate {
  collection: ReadCollection;
  pipeline: Document[];
  responseBytesLimit: number;
}

export function prepareFind(args: Record<string, unknown>): PreparedFind {
  const collection = readCollection(args.collection);
  const filter = readOptionalDocument(args.filter, "filter");
  const projection = readOptionalDocument(args.projection, "projection");
  const sort = readOptionalDocument(args.sort, "sort");
  assertReadOnly(filter, "filter");
  if (projection) {
    assertReadOnly(projection, "projection");
  }
  if (sort) {
    assertReadOnly(sort, "sort");
  }
  return {
    collection,
    filter,
    ...(projection ? { projection } : {}),
    ...(sort ? { sort } : {}),
    limit: readInteger(args.limit, "limit", { defaultValue: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT }),
    skip: readInteger(args.skip, "skip", { defaultValue: 0, min: 0, max: MAX_SKIP }),
    responseBytesLimit: readByteLimit(args.responseBytesLimit),
  };
}

export function prepareAggregate(args: Record<string, unknown>): PreparedAggregate {
  if (!Array.isArray(args.pipeline)) {
    throw new McpQueryError("pipeline must be an array of stages.");
  }
  if (args.pipeline.length === 0) {
    throw new McpQueryError("pipeline needs at least one stage.");
  }
  if (args.pipeline.length > MAX_PIPELINE_STAGES) {
    throw new McpQueryError(`pipeline is limited to ${MAX_PIPELINE_STAGES} stages.`);
  }
  const pipeline: Document[] = [];
  for (const [index, stage] of args.pipeline.entries()) {
    if (!isRecord(stage)) {
      throw new McpQueryError(`pipeline stage ${index} must be an object.`);
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      throw new McpQueryError(`pipeline stage ${index} must contain one operator.`);
    }
    pipeline.push(stage);
  }
  const decoded = decodeDocument(pipeline, "pipeline");
  if (!Array.isArray(decoded)) {
    throw new McpQueryError("pipeline must be an array of stages.");
  }
  assertReadOnly(decoded, "pipeline");
  return {
    collection: readCollection(args.collection),
    pipeline: decoded as Document[],
    responseBytesLimit: readByteLimit(args.responseBytesLimit),
  };
}

export function prepareCount(args: Record<string, unknown>): { collection: ReadCollection; filter: Document } {
  const rawFilter = args.filter !== undefined ? args.filter : args.query;
  const filter = readOptionalDocument(rawFilter, "filter");
  assertReadOnly(filter, "filter");
  return { collection: readCollection(args.collection), filter };
}

export function prepareCollection(args: Record<string, unknown>): ReadCollection {
  return readCollection(args.collection);
}

export function prepareSample(args: Record<string, unknown>): { collection: ReadCollection; sampleSize: number; responseBytesLimit: number } {
  return {
    collection: readCollection(args.collection),
    sampleSize: readInteger(args.sampleSize, "sampleSize", {
      defaultValue: DEFAULT_SAMPLE_SIZE,
      min: 1,
      max: MAX_SAMPLE_SIZE,
    }),
    responseBytesLimit: readByteLimit(args.responseBytesLimit),
  };
}

export function readToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new McpQueryError("Tool arguments must be an object.");
  }
  return value;
}

function readCollection(value: unknown): ReadCollection {
  if (typeof value !== "string" || !isReadCollection(value)) {
    throw new McpQueryError("collection must be food, observations, or kinds.");
  }
  return value;
}

function readOptionalDocument(value: unknown, label: string): Document {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new McpQueryError(`${label} must be an object.`);
  }
  const decoded = decodeDocument(value, label);
  if (!isRecord(decoded)) {
    throw new McpQueryError(`${label} must be an object.`);
  }
  return decoded as Document;
}

function decodeDocument(value: unknown, label: string): unknown {
  try {
    return decodeExtendedJson(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    throw new McpQueryError(detail ? `That Extended JSON in ${label} isn't valid. ${detail}` : `That Extended JSON in ${label} isn't valid.`);
  }
}

function readByteLimit(value: unknown): number {
  const requested = readInteger(value, "responseBytesLimit", {
    defaultValue: DEFAULT_RESPONSE_BYTES,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  return Math.min(requested, MAX_RESPONSE_BYTES);
}

function readInteger(
  value: unknown,
  label: string,
  bounds: { defaultValue: number; min: number; max: number },
): number {
  if (value === undefined) {
    return bounds.defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new McpQueryError(`${label} must be an integer.`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new McpQueryError(`${label} must be from ${bounds.min} to ${bounds.max}.`);
  }
  return value;
}

function assertReadOnly(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new McpQueryError(`${label} is nested too deeply.`);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertReadOnly(item, label, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      throw new McpQueryError(`${key} is not allowed. This endpoint only reads food, observations, and kinds.`);
    }
    assertReadOnly(child, label, depth + 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

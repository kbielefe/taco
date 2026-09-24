import type { Document } from "mongodb";

export const READ_COLLECTIONS = ["food", "observations", "kinds"] as const;
export type ReadCollection = (typeof READ_COLLECTIONS)[number];

export const QUERY_MAX_TIME_MS = 10_000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_SKIP = 10_000;
export const DEFAULT_RESPONSE_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_SAMPLE_SIZE = 20;
export const MAX_SAMPLE_SIZE = 100;
export const MAX_AGGREGATE_DOCUMENTS = 100;

export interface FindOptions {
  projection?: Document;
  sort?: Document;
  limit: number;
  skip: number;
}

/** Read-only access to the health database. Implementations must not write. */
export interface DataCatalog {
  find(collection: ReadCollection, filter: Document, options: FindOptions): Promise<Document[]>;
  aggregate(collection: ReadCollection, pipeline: Document[]): Promise<Document[]>;
  count(collection: ReadCollection, filter: Document): Promise<number>;
  indexes(collection: ReadCollection): Promise<Document[]>;
}

export function isReadCollection(value: string): value is ReadCollection {
  return (READ_COLLECTIONS as readonly string[]).includes(value);
}

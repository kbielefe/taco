import type { Db, Document } from "mongodb";
import {
  MAX_AGGREGATE_DOCUMENTS,
  QUERY_MAX_TIME_MS,
  type DataCatalog,
  type FindOptions,
  type ReadCollection,
} from "./catalog.js";

const COMMENT = "health-tracker-mcp";

export function mongoCatalog(db: Db): DataCatalog {
  return {
    async find(collection: ReadCollection, filter: Document, options: FindOptions): Promise<Document[]> {
      return db
        .collection(collection)
        .find(filter, {
          projection: options.projection,
          sort: options.sort,
          limit: options.limit,
          skip: options.skip,
          maxTimeMS: QUERY_MAX_TIME_MS,
          comment: COMMENT,
        })
        .toArray();
    },

    async aggregate(collection: ReadCollection, pipeline: Document[]): Promise<Document[]> {
      const cursor = db.collection(collection).aggregate(pipeline, {
        maxTimeMS: QUERY_MAX_TIME_MS,
        comment: COMMENT,
      });
      const documents: Document[] = [];
      for await (const document of cursor) {
        documents.push(document as Document);
        if (documents.length > MAX_AGGREGATE_DOCUMENTS) {
          await cursor.close();
          break;
        }
      }
      return documents;
    },

    async count(collection: ReadCollection, filter: Document): Promise<number> {
      return db.collection(collection).countDocuments(filter, {
        maxTimeMS: QUERY_MAX_TIME_MS,
        comment: COMMENT,
      });
    },

    async indexes(collection: ReadCollection): Promise<Document[]> {
      return db.collection(collection).indexes();
    },
  };
}

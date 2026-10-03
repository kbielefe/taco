import type { Db, Document } from "mongodb";
import { withToolSpan } from "../mlflow/tracing.js";
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
      return withToolSpan(
        `mongo ${collection}.find`,
        { collection, filter, sort: options.sort, limit: options.limit, skip: options.skip },
        () =>
          db
            .collection(collection)
            .find(filter, {
              projection: options.projection,
              sort: options.sort,
              limit: options.limit,
              skip: options.skip,
              maxTimeMS: QUERY_MAX_TIME_MS,
              comment: COMMENT,
            })
            .toArray(),
        (documents) => ({ count: documents.length }),
      );
    },

    async aggregate(collection: ReadCollection, pipeline: Document[]): Promise<Document[]> {
      return withToolSpan(
        `mongo ${collection}.aggregate`,
        { collection, pipeline },
        async () => {
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
        (documents) => ({ count: documents.length }),
      );
    },

    async count(collection: ReadCollection, filter: Document): Promise<number> {
      return withToolSpan(
        `mongo ${collection}.count`,
        { collection, filter },
        () =>
          db.collection(collection).countDocuments(filter, {
            maxTimeMS: QUERY_MAX_TIME_MS,
            comment: COMMENT,
          }),
        (count) => ({ count }),
      );
    },

    async indexes(collection: ReadCollection): Promise<Document[]> {
      return withToolSpan(
        `mongo ${collection}.indexes`,
        { collection },
        () => db.collection(collection).indexes(),
        (indexes) => ({ count: indexes.length }),
      );
    },
  };
}

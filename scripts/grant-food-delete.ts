import { MongoClient } from "mongodb";

const username = process.env.MONGO_ROOT_USERNAME;
const password = process.env.MONGO_ROOT_PASSWORD;
if (!username || !password) {
  throw new Error("MONGO_ROOT_USERNAME and MONGO_ROOT_PASSWORD are required");
}

const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:27017/?authSource=admin`;
const client = new MongoClient(uri);

const privileges = [
  {
    resource: { db: "health", collection: "food" },
    actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
  },
];

try {
  await client.connect();
  const health = client.db("health");
  await health.command({
    updateRole: "foodLog",
    privileges,
    roles: [],
  });
  console.log("Granted remove on health.food to role foodLog");
} finally {
  await client.close();
}

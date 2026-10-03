import { MongoClient, MongoServerError } from "mongodb";

const username = process.env.MONGO_ROOT_USERNAME;
const password = process.env.MONGO_ROOT_PASSWORD;
const appUser = process.env.MONGO_CACHE_USERNAME;
if (!username || !password || !appUser) {
  throw new Error("MONGO_ROOT_USERNAME, MONGO_ROOT_PASSWORD, and MONGO_CACHE_USERNAME are required");
}

const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:27017/?authSource=admin`;
const client = new MongoClient(uri);

const privileges = [
  {
    resource: { db: "health", collection: "oauth" },
    actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
  },
];

function alreadyExists(error: unknown): boolean {
  return error instanceof MongoServerError && (error.codeName === "DuplicateKey" || /already exists/i.test(error.message));
}

try {
  await client.connect();
  const health = client.db("health");
  try {
    await health.command({ createRole: "oauth", privileges, roles: [] });
  } catch (error) {
    if (!alreadyExists(error)) {
      throw error;
    }
    await health.command({ updateRole: "oauth", privileges, roles: [] });
  }

  const info = await health.command({ usersInfo: appUser });
  const users = info.users as { roles?: { role: string; db: string }[] }[] | undefined;
  const roles = users?.[0]?.roles ?? [];
  const granted = roles.some((role) => role.role === "oauth" && role.db === "health");
  if (!granted) {
    await health.command({
      grantRolesToUser: appUser,
      roles: [{ role: "oauth", db: "health" }],
    });
  }
  console.log("Granted oauth role on health.oauth");
} finally {
  await client.close();
}

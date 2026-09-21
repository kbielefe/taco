#!/bin/bash
set -euo pipefail

if [[ -z "${MONGO_CACHE_USERNAME:-}" || -z "${MONGO_CACHE_PASSWORD:-}" ]]; then
  echo "MONGO_CACHE_USERNAME and MONGO_CACHE_PASSWORD must be set" >&2
  exit 1
fi

mongosh --quiet \
  -u "${MONGO_INITDB_ROOT_USERNAME}" \
  -p "${MONGO_INITDB_ROOT_PASSWORD}" \
  --authenticationDatabase admin <<EOF
const health = db.getSiblingDB("health");

try {
  health.createRole({
    role: "cacheOnly",
    privileges: [
      {
        resource: { db: "health", collection: "cache" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
    ],
    roles: [],
  });
} catch (error) {
  if (error.codeName !== "DuplicateKey" && !/already exists/i.test(String(error.message))) {
    throw error;
  }
  health.updateRole("cacheOnly", {
    privileges: [
      {
        resource: { db: "health", collection: "cache" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
    ],
    roles: [],
  });
}

try {
  health.createRole({
    role: "foodLog",
    privileges: [
      {
        resource: { db: "health", collection: "food" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
    ],
    roles: [],
  });
} catch (error) {
  if (error.codeName !== "DuplicateKey" && !/already exists/i.test(String(error.message))) {
    throw error;
  }
  health.updateRole("foodLog", {
    privileges: [
      {
        resource: { db: "health", collection: "food" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
    ],
    roles: [],
  });
}

try {
  health.createRole({
    role: "journal",
    privileges: [
      {
        resource: { db: "health", collection: "kinds" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
      {
        resource: { db: "health", collection: "observations" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
    ],
    roles: [],
  });
} catch (error) {
  if (error.codeName !== "DuplicateKey" && !/already exists/i.test(String(error.message))) {
    throw error;
  }
  health.updateRole("journal", {
    privileges: [
      {
        resource: { db: "health", collection: "kinds" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
      {
        resource: { db: "health", collection: "observations" },
        actions: ["find", "insert", "update", "remove", "createIndex", "listIndexes"],
      },
    ],
    roles: [],
  });
}

const appRoles = [
  { role: "cacheOnly", db: "health" },
  { role: "foodLog", db: "health" },
  { role: "journal", db: "health" },
];

const existingUsers = health.getUsers().users ?? [];
const exists = existingUsers.some((user) => user.user === "${MONGO_CACHE_USERNAME}");
if (!exists) {
  health.createUser({
    user: "${MONGO_CACHE_USERNAME}",
    pwd: "${MONGO_CACHE_PASSWORD}",
    roles: appRoles,
  });
} else {
  health.updateUser("${MONGO_CACHE_USERNAME}", {
    pwd: "${MONGO_CACHE_PASSWORD}",
    roles: appRoles,
  });
}
EOF

import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

const COLLECTION_NAME = "ai_reply_escalations";
const EXPECTED_DATABASE_NAME = "whatsapp_sales_assistant";
const UNIQUE_INDEX = {
  key: { businessId: 1, inboundMessageId: 1 },
  options: { unique: true, name: "ai_reply_escalations_business_inbound_unique" },
};
const REVIEW_INDEX = {
  key: { businessId: 1, status: 1, createdAt: -1, _id: -1 },
  options: { name: "ai_reply_escalations_business_status_created" },
};
const SAFE_ERRORS = new Set([
  "missing_migration_uri",
  "invalid_migration_uri",
  "invalid_migration_uri_scheme",
  "migration_uri_requires_database_name",
  "database_confirmation_required",
  "unknown_migration_argument",
  "conflicting_migration_modes",
  "database_name_confirmation_mismatch",
  "production_database_requires_additional_confirmation",
  "connected_database_name_mismatch",
]);

function parseArguments(args) {
  let apply = false;
  let dryRun = false;
  let confirmDatabase;
  let confirmProductionDatabase = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--confirm-production-database") confirmProductionDatabase = true;
    else if (argument === "--confirm-database") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error("database_confirmation_required");
      confirmDatabase = next;
      index += 1;
    } else throw new Error("unknown_migration_argument");
  }
  if (apply && dryRun) throw new Error("conflicting_migration_modes");
  return { mode: apply ? "apply" : "dry-run", confirmDatabase, confirmProductionDatabase };
}

function databaseNameFromUri(uri) {
  if (!uri) throw new Error("missing_migration_uri");
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("invalid_migration_uri");
  }
  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
    throw new Error("invalid_migration_uri_scheme");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !databaseName || parsed.hash) throw new Error("migration_uri_requires_database_name");
  return databaseName;
}

function validateTarget(options, databaseName) {
  if (options.mode === "apply" && options.confirmDatabase !== databaseName) {
    throw new Error("database_name_confirmation_mismatch");
  }
  if (options.mode === "apply" && databaseName === EXPECTED_DATABASE_NAME && !options.confirmProductionDatabase) {
    throw new Error("production_database_requires_additional_confirmation");
  }
}

async function ensureCollection(database) {
  const exists = await database.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
  if (exists) return false;
  try {
    await database.createCollection(COLLECTION_NAME);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 48) return false;
    throw error;
  }
}

async function run() {
  let connected = false;
  try {
    const options = parseArguments(process.argv.slice(2));
    const uri = process.env.MONGODB_MIGRATION_URI;
    const databaseName = databaseNameFromUri(uri);
    validateTarget(options, databaseName);
    await mongoose.connect(uri, {
      dbName: databaseName,
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 10_000,
    });
    connected = true;
    if (mongoose.connection.name !== databaseName || !mongoose.connection.db) {
      throw new Error("connected_database_name_mismatch");
    }

    console.log(`AI reply escalation index migration: ${options.mode}`);
    console.log(`Target database: ${databaseName}`);
    const database = mongoose.connection.db;
    if (options.mode === "dry-run") {
      const exists = await database.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
      console.log(`  collection ${COLLECTION_NAME}: ${exists ? "exists" : "would be created"}`);
      console.log(`  indexes: ${UNIQUE_INDEX.options.name}, ${REVIEW_INDEX.options.name}`);
      console.log("  no collection or index changes were made");
      return;
    }

    const created = await ensureCollection(database);
    const collection = database.collection(COLLECTION_NAME);
    await collection.createIndex(UNIQUE_INDEX.key, UNIQUE_INDEX.options);
    await collection.createIndex(REVIEW_INDEX.key, REVIEW_INDEX.options);
    console.log(`  collection: ${created ? "created" : "already existed"}`);
    console.log("  declared indexes created or already present; no documents were changed");
  } catch (error) {
    const category = error instanceof Error && SAFE_ERRORS.has(error.message)
      ? error.message
      : "migration_failed";
    console.error(`AI reply escalation index migration stopped: ${category}.`);
    process.exitCode = 1;
  } finally {
    if (connected) {
      try {
        await mongoose.disconnect();
      } catch {
        console.error("AI reply escalation index migration disconnect failed.");
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();

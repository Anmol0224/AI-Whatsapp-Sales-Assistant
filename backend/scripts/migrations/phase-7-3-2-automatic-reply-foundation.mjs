import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

export const AUTOMATIC_REPLY_FOUNDATION_STEPS = Object.freeze([
  Object.freeze({
    name: "legacy-ai-conversations-to-ai-draft",
    collection: "conversations",
    filter: Object.freeze({ responseMode: "ai" }),
    update: Object.freeze({ $set: Object.freeze({ responseMode: "ai_draft" }) }),
  }),
  Object.freeze({
    name: "default-business-automatic-replies-off",
    collection: "businesses",
    filter: Object.freeze({ "aiSettings.automaticRepliesEnabled": Object.freeze({ $exists: false }) }),
    update: Object.freeze({ $set: Object.freeze({ "aiSettings.automaticRepliesEnabled": false }) }),
  }),
  Object.freeze({
    name: "legacy-jobs-to-draft-workflow",
    collection: "aireplyjobs",
    filter: Object.freeze({ workflow: Object.freeze({ $exists: false }) }),
    update: Object.freeze({ $set: Object.freeze({ workflow: "ai_draft" }) }),
  }),
]);

const REQUIRED_COLLECTIONS = Object.freeze(["conversations", "businesses", "aireplyjobs"]);
const KNOWN_PRODUCTION_DATABASE = "whatsapp_sales_assistant";
const SAFE_MIGRATION_ERRORS = new Set([
  "missing_migration_uri",
  "invalid_migration_uri",
  "invalid_migration_uri_scheme",
  "invalid_migration_database_name",
  "migration_uri_requires_database_name",
  "database_confirmation_required",
  "unknown_migration_argument",
  "conflicting_migration_modes",
  "database_name_confirmation_mismatch",
  "production_database_requires_additional_confirmation",
  "connected_database_name_mismatch",
  "required_application_collection_missing",
]);

export function parseMigrationArguments(args) {
  let apply = false;
  let dryRun = false;
  let confirmDatabase;
  let confirmProductionDatabase = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--confirm-production-database") {
      confirmProductionDatabase = true;
    } else if (argument === "--confirm-database") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error("database_confirmation_required");
      confirmDatabase = next;
      index += 1;
    } else {
      throw new Error("unknown_migration_argument");
    }
  }

  if (apply && dryRun) throw new Error("conflicting_migration_modes");
  return {
    mode: apply ? "apply" : "dry-run",
    confirmDatabase,
    confirmProductionDatabase,
  };
}

export function validateMigrationTarget(options, databaseName) {
  if (options.mode === "apply" && options.confirmDatabase !== databaseName) {
    throw new Error("database_name_confirmation_mismatch");
  }
  if (options.mode === "apply" && databaseName === KNOWN_PRODUCTION_DATABASE &&
    !options.confirmProductionDatabase) {
    throw new Error("production_database_requires_additional_confirmation");
  }
}

function parseDatabaseName(uri) {
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
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("invalid_migration_database_name");
  }
  if (!parsed.hostname || !databaseName || parsed.hash) {
    throw new Error("migration_uri_requires_database_name");
  }
  return databaseName;
}

async function runMigration() {
  let connected = false;
  try {
    const options = parseMigrationArguments(process.argv.slice(2));
    const uri = process.env.MONGODB_MIGRATION_URI;
    const databaseName = parseDatabaseName(uri);
    validateMigrationTarget(options, databaseName);

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

    const database = mongoose.connection.db;
    const existingCollections = new Set(
      (await database.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name),
    );
    if (REQUIRED_COLLECTIONS.some((name) => name !== "aireplyjobs" && !existingCollections.has(name))) {
      throw new Error("required_application_collection_missing");
    }

    console.log(`Automatic reply foundation migration: ${options.mode}`);
    console.log(`Target database: ${databaseName}`);
    for (const step of AUTOMATIC_REPLY_FOUNDATION_STEPS) {
      if (!existingCollections.has(step.collection)) {
        console.log(`  ${step.name}: collection absent; no collection created`);
        continue;
      }
      const collection = database.collection(step.collection);
      if (options.mode === "dry-run") {
        const matchingDocuments = await collection.countDocuments(step.filter);
        console.log(`  ${step.name}: ${matchingDocuments} matching documents; no data changed`);
      } else {
        const result = await collection.updateMany(step.filter, step.update);
        console.log(`  ${step.name}: ${result.modifiedCount} documents updated`);
      }
    }
    if (options.mode === "apply") console.log("Migration completed; rerunning is safe.");
  } catch (error) {
    const category = error instanceof Error && SAFE_MIGRATION_ERRORS.has(error.message)
      ? error.message
      : "migration_failed";
    console.error(`Automatic reply foundation migration stopped: ${category}.`);
    process.exitCode = 1;
  } finally {
    if (connected) {
      try {
        await mongoose.disconnect();
      } catch {
        console.error("Automatic reply foundation migration disconnect failed.");
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigration();
}

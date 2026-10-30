import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const envFilePath = fileURLToPath(new URL("../../.env", import.meta.url));
const dotenvResult = dotenv.config({ path: envFilePath });

if (dotenvResult.error && (dotenvResult.error as NodeJS.ErrnoException).code !== "ENOENT") {
  throw new Error("Unable to load backend/.env.");
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  FRONTEND_ORIGIN: z
    .string()
    .url()
    .refine((value) => new URL(value).origin === value, {
      message: "must be an origin URL without a path",
    })
    .default("http://localhost:5173"),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const validationDetails = parsedEnvironment.error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("\n- ");

  throw new Error(`Invalid environment configuration:\n- ${validationDetails}`);
}

export const env = parsedEnvironment.data;

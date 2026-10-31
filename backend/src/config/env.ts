import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const envFilePath = fileURLToPath(new URL("../../.env", import.meta.url));
const dotenvResult = dotenv.config({ path: envFilePath });

if (dotenvResult.error && (dotenvResult.error as NodeJS.ErrnoException).code !== "ENOENT") {
  throw new Error("Unable to load backend/.env.");
}

const jwtExpiryMultipliers = { s: 1, m: 60, h: 3600, d: 86400 } as const;

function toJwtExpirySeconds(value: string): number {
  const unit = value.at(-1) as keyof typeof jwtExpiryMultipliers;
  return Number(value.slice(0, -1)) * jwtExpiryMultipliers[unit];
}

function optionalSetting<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z
    .string()
    .min(1)
    .refine((value) => /^mongodb(?:\+srv)?:\/\//i.test(value), {
      message: "must start with mongodb:// or mongodb+srv://",
    }),
  JWT_SECRET: z
    .string()
    .min(32, "must be at least 32 characters long")
    .refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
      message: "must be at least 32 UTF-8 bytes",
    })
    .refine((value) => !value.startsWith("REPLACE_WITH_"), {
      message: "must be replaced with a generated secret",
    }),
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^[1-9]\d*[smhd]$/, "must be a positive duration such as 1h, 30m, or 7d")
    .default("1h")
    .transform(toJwtExpirySeconds)
    .refine(Number.isSafeInteger, "must resolve to a safe integer number of seconds"),
  FRONTEND_ORIGIN: z
    .string()
    .url()
    .refine((value) => new URL(value).origin === value, {
      message: "must be an origin URL without a path",
    })
    .default("http://localhost:5173"),
  META_GRAPH_API_VERSION: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .trim()
      .regex(/^v\d+\.\d+$/, "must use the version format vNN.N, for example v26.0")
      .default("v26.0"),
  ),
  WHATSAPP_ACCESS_TOKEN: optionalSetting(
    z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .regex(/^\S+$/, "must not contain whitespace"),
  ),
  WHATSAPP_VERIFY_TOKEN: optionalSetting(
    z
      .string()
      .trim()
      .min(32, "must be at least 32 characters long")
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/, "must contain only letters, numbers, dots, underscores, tildes, or hyphens"),
  ),
  META_APP_SECRET: optionalSetting(
    z.string().trim().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-character hexadecimal value"),
  ),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const validationDetails = parsedEnvironment.error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("\n- ");

  throw new Error(`Invalid environment configuration:\n- ${validationDetails}`);
}

export const env = parsedEnvironment.data;

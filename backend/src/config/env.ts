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
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const validationDetails = parsedEnvironment.error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("\n- ");

  throw new Error(`Invalid environment configuration:\n- ${validationDetails}`);
}

export const env = parsedEnvironment.data;

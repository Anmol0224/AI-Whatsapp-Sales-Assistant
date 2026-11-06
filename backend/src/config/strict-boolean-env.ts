import { z } from "zod";

/** Accepts only the literal environment strings true/false; unset defaults to false. */
export const strictBooleanEnvSchema = z
  .preprocess(
    (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
    z.enum(["true", "false"]).default("false"),
  )
  .transform((value) => value === "true");

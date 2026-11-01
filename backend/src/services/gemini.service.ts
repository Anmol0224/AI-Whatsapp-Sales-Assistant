import {
  ApiError,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";

export const GEMINI_REQUEST_TIMEOUT_MS = 15_000;
export const GEMINI_MAX_INPUT_BYTES = 32_000;
export const GEMINI_MAX_OUTPUT_TOKENS = 1_024;
export const GEMINI_MAX_OUTPUT_CHARACTERS = 4_096;

export type GeminiServiceErrorCategory =
  | "missing_credentials"
  | "invalid_request"
  | "input_too_large"
  | "timeout"
  | "rate_limited"
  | "authentication_failed"
  | "permission_denied"
  | "empty_response"
  | "invalid_response"
  | "output_too_large"
  | "provider_error";

const publicMessages: Record<GeminiServiceErrorCategory, string> = {
  missing_credentials: "Gemini is not configured.",
  invalid_request: "The text-generation request is invalid.",
  input_too_large: "The text-generation request exceeds the configured size limit.",
  timeout: "Gemini did not respond before the request timed out.",
  rate_limited: "Gemini is temporarily rate-limiting requests.",
  authentication_failed: "Gemini rejected the configured credentials.",
  permission_denied: "The configured Gemini credentials do not have permission to use this model.",
  empty_response: "Gemini returned no text.",
  invalid_response: "Gemini returned an invalid response.",
  output_too_large: "Gemini returned text that exceeds the configured size limit.",
  provider_error: "Gemini text generation failed.",
};

export class GeminiServiceError extends Error {
  readonly category: GeminiServiceErrorCategory;

  constructor(category: GeminiServiceErrorCategory) {
    super(publicMessages[category]);
    this.name = "GeminiServiceError";
    this.category = category;
  }
}

export interface GeminiTextGenerationRequest {
  prompt: string;
}

export interface GeminiTextGenerationResult {
  text: string;
  model: string;
}

export interface GeminiTextProvider {
  generateContent(
    request: GenerateContentParameters,
  ): Promise<Pick<GenerateContentResponse, "text">>;
}

export type GeminiProviderFactory = (apiKey: string) => GeminiTextProvider;

export interface GeminiServiceOptions {
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

function createSdkProvider(apiKey: string): GeminiTextProvider {
  const client = new GoogleGenAI({ apiKey });
  return {
    generateContent: (request) => client.models.generateContent(request),
  };
}

function statusFromError(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (typeof error !== "object" || error === null) return undefined;

  const status = "status" in error ? error.status : undefined;
  if (typeof status === "number") return status;
  const statusCode = "statusCode" in error ? error.statusCode : undefined;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function nameFromError(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "";
  return typeof error.name === "string" ? error.name.toLowerCase() : "";
}

function categoryFromProviderError(error: unknown): GeminiServiceErrorCategory {
  const status = statusFromError(error);
  if (status === 429) return "rate_limited";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_denied";

  const name = nameFromError(error);
  if (
    name.includes("timeout") ||
    name.includes("abort") ||
    (typeof error === "object" && error !== null && "code" in error &&
      (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED"))
  ) {
    return "timeout";
  }

  return "provider_error";
}

export function createGeminiService(
  options: GeminiServiceOptions,
  providerFactory: GeminiProviderFactory = createSdkProvider,
) {
  const timeoutMs = options.timeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("GEMINI_TIMEOUT_CONFIGURATION_INVALID");
  }

  let provider: GeminiTextProvider | undefined;

  async function generateText(
    request: GeminiTextGenerationRequest,
  ): Promise<GeminiTextGenerationResult> {
    if (!options.apiKey) throw new GeminiServiceError("missing_credentials");
    if (typeof request?.prompt !== "string" || !request.prompt.trim()) {
      throw new GeminiServiceError("invalid_request");
    }

    const prompt = request.prompt.trim();
    if (Buffer.byteLength(prompt, "utf8") > GEMINI_MAX_INPUT_BYTES) {
      throw new GeminiServiceError("input_too_large");
    }

    try {
      provider ??= providerFactory(options.apiKey);
      const response = await provider.generateContent({
        model: options.model,
        contents: prompt,
        config: {
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          automaticContinuation: false,
          httpOptions: {
            timeout: timeoutMs,
            retryOptions: { attempts: 1 },
          },
        },
      });

      let candidateText: unknown;
      try {
        candidateText = response?.text;
      } catch {
        throw new GeminiServiceError("invalid_response");
      }

      if (typeof candidateText !== "string") {
        throw new GeminiServiceError("invalid_response");
      }

      const text = candidateText.trim();
      if (!text) throw new GeminiServiceError("empty_response");
      if (text.length > GEMINI_MAX_OUTPUT_CHARACTERS) {
        throw new GeminiServiceError("output_too_large");
      }

      return { text, model: options.model };
    } catch (error) {
      if (error instanceof GeminiServiceError) throw error;
      throw new GeminiServiceError(categoryFromProviderError(error));
    }
  }

  return { generateText };
}

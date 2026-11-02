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

export type GeminiProviderDiagnosticCategory =
  | "rate_limited"
  | "authentication_failed"
  | "permission_denied"
  | "timeout"
  | "network_error"
  | "provider_5xx"
  | "provider_error";

export interface GeminiProviderDiagnostic {
  readonly category: GeminiProviderDiagnosticCategory;
  readonly httpStatus?: number;
  readonly networkCode?: string;
}

const allowedHttpStatuses = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);
const allowedNetworkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

// These names correspond to the SDK's known API and HTTP-client error classes.
// The classes beneath GoogleGenAI's public ApiError are not exported by the SDK.
const sdkApiErrorNames = new Set([
  "APIError",
  "BadRequestError",
  "AuthenticationError",
  "PermissionDeniedError",
  "NotFoundError",
  "ConflictError",
  "UnprocessableEntityError",
  "RateLimitError",
  "InternalServerError",
]);
const sdkTimeoutErrorNames = new Set(["APIConnectionTimeoutError", "RequestTimeoutError"]);
const sdkConnectionErrorNames = new Set(["APIConnectionError", "ConnectionError"]);
const sdkAbortErrorNames = new Set(["APIUserAbortError", "RequestAbortedError"]);

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
  readonly diagnostic: GeminiProviderDiagnostic | undefined;

  constructor(category: GeminiServiceErrorCategory, diagnostic?: GeminiProviderDiagnostic) {
    super(publicMessages[category]);
    this.name = "GeminiServiceError";
    this.category = category;
    this.diagnostic = diagnostic;
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

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function sdkErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const name = ownDataValue(error, "name");
  return typeof name === "string" ? name : undefined;
}

function verifiedSdkErrorName(error: unknown): string | undefined {
  const name = sdkErrorName(error);
  if (!name) return undefined;
  if (error instanceof ApiError || sdkApiErrorNames.has(name) ||
    sdkTimeoutErrorNames.has(name) || sdkConnectionErrorNames.has(name) ||
    sdkAbortErrorNames.has(name)) {
    return name;
  }
  return undefined;
}

function verifiedHttpStatus(error: unknown, name: string): number | undefined {
  if (!(error instanceof ApiError) && !sdkApiErrorNames.has(name)) return undefined;
  if (typeof error !== "object" || error === null) return undefined;

  const status = ownDataValue(error, "status");
  const statusCode = ownDataValue(error, "statusCode");
  if (status !== undefined && statusCode !== undefined && status !== statusCode) return undefined;
  const candidate = status ?? statusCode;
  return typeof candidate === "number" && Number.isInteger(candidate) &&
      allowedHttpStatuses.has(candidate)
    ? candidate
    : undefined;
}

function knownNetworkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const code = ownDataValue(current, "code");
    if (typeof code === "string" && allowedNetworkCodes.has(code)) return code;
    if (depth === 2) return undefined;
    current = ownDataValue(current, "cause");
  }
  return undefined;
}

function classifyProviderError(error: unknown): {
  category: GeminiServiceErrorCategory;
  diagnostic: GeminiProviderDiagnostic;
} {
  const name = verifiedSdkErrorName(error);
  if (!name) {
    return { category: "provider_error", diagnostic: { category: "provider_error" } };
  }

  const httpStatus = verifiedHttpStatus(error, name);
  if (httpStatus === 429) {
    return { category: "rate_limited", diagnostic: { category: "rate_limited", httpStatus } };
  }
  if (httpStatus === 401) {
    return { category: "authentication_failed", diagnostic: { category: "authentication_failed", httpStatus } };
  }
  if (httpStatus === 403) {
    return { category: "permission_denied", diagnostic: { category: "permission_denied", httpStatus } };
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return { category: "provider_error", diagnostic: { category: "provider_5xx", httpStatus } };
  }

  if (sdkTimeoutErrorNames.has(name) || sdkAbortErrorNames.has(name)) {
    return {
      category: "timeout",
      diagnostic: { category: "timeout", ...(httpStatus === undefined ? {} : { httpStatus }) },
    };
  }

  if (httpStatus === 408) {
    return { category: "provider_error", diagnostic: { category: "timeout", httpStatus } };
  }

  if (sdkConnectionErrorNames.has(name)) {
    const networkCode = knownNetworkCode(error);
    return {
      category: "provider_error",
      diagnostic: {
        category: "network_error",
        ...(networkCode === undefined ? {} : { networkCode }),
      },
    };
  }

  return {
    category: "provider_error",
    diagnostic: {
      category: "provider_error",
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  };
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
      const classified = classifyProviderError(error);
      throw new GeminiServiceError(classified.category, classified.diagnostic);
    }
  }

  return { generateText };
}

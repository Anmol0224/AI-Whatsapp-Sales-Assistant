import type { ErrorRequestHandler } from "express";

function getRequestBodyError(error: unknown): { status: number; message: string } | null {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return null;
  }

  if (error.type === "entity.parse.failed") {
    return { status: 400, message: "Malformed JSON request body." };
  }

  if (error.type === "entity.too.large") {
    return { status: 413, message: "Request body is too large. The limit is 100 KB." };
  }

  return null;
}

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const bodyError = getRequestBodyError(error);

  if (bodyError) {
    response.status(bodyError.status).json({
      success: false,
      message: bodyError.message,
    });
    return;
  }

  response.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

export default errorHandler;

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { UserRole } from "../models/user.model.js";

export interface AuthenticatedUser {
  userId: string;
  businessId: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}

function unauthorized(response: Response): void {
  response.setHeader("WWW-Authenticate", "Bearer");
  response.status(401).json({ success: false, message: "Authentication required." });
}

export function authenticate(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);

  if (!match) {
    unauthorized(response);
    return;
  }

  try {
    const payload = jwt.verify(match[1], env.JWT_SECRET, { algorithms: ["HS256"] });

    if (
      typeof payload === "string" ||
      typeof payload.userId !== "string" ||
      !/^[a-f\d]{24}$/i.test(payload.userId) ||
      typeof payload.businessId !== "string" ||
      !/^[a-f\d]{24}$/i.test(payload.businessId) ||
      payload.role !== "owner"
    ) {
      unauthorized(response);
      return;
    }

    request.auth = {
      userId: payload.userId,
      businessId: payload.businessId,
      role: payload.role,
    };
    next();
  } catch {
    unauthorized(response);
  }
}

import bcrypt from "bcrypt";
import { Router } from "express";
import jwt from "jsonwebtoken";
import mongoose, { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/auth.middleware.js";
import { Business } from "../../models/business.model.js";
import { User } from "../../models/user.model.js";

const authRouter = Router();
const bcryptSaltRounds = 12;

const registrationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters long.")
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
        message: "Password must be no more than 72 UTF-8 bytes.",
      }),
    businessName: z.string().trim().min(1).max(150),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    password: z.string().min(1),
  })
  .strict();

const invalidCredentialsMessage = "Invalid email or password.";

function isDuplicateEmailError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 11000) {
    return false;
  }

  const duplicateError = error as {
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
  };

  return (
    duplicateError.keyPattern?.email !== undefined ||
    duplicateError.keyValue?.email !== undefined
  );
}

authRouter.post("/register", async (request, response, next) => {
  const parsedBody = registrationSchema.safeParse(request.body);

  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid registration data.",
      errors: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { name, email, password, businessName } = parsedBody.data;

  try {
    const passwordHash = await bcrypt.hash(password, bcryptSaltRounds);
    const userId = new Types.ObjectId();
    const businessId = new Types.ObjectId();
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const user = new User({
          _id: userId,
          name,
          email,
          passwordHash,
          businessId,
          role: "owner",
        });
        const business = new Business({
          _id: businessId,
          ownerUserId: userId,
          name: businessName,
        });

        await user.save({ session });
        await business.save({ session });
      });
    } finally {
      await session.endSession();
    }

    response.status(201).json({
      user: {
        id: userId.toString(),
        name,
        email,
      },
      business: {
        id: businessId.toString(),
        name: businessName,
      },
    });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      response.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
      return;
    }

    next(error);
  }
});

authRouter.post("/login", async (request, response, next) => {
  const parsedBody = loginSchema.safeParse(request.body);

  if (!parsedBody.success) {
    response.status(400).json({
      success: false,
      message: "Invalid login data.",
      errors: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { email, password } = parsedBody.data;

  try {
    const user = await User.findOne({ email }).select("+passwordHash");

    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      response.status(401).json({ success: false, message: invalidCredentialsMessage });
      return;
    }

    const business = await Business.findOne({ _id: user.businessId, ownerUserId: user._id });

    if (!business) {
      response.status(401).json({ success: false, message: invalidCredentialsMessage });
      return;
    }

    const token = jwt.sign(
      {
        userId: user._id.toString(),
        businessId: business._id.toString(),
        role: user.role,
      },
      env.JWT_SECRET,
      {
        algorithm: "HS256",
        expiresIn: env.JWT_EXPIRES_IN,
        subject: user._id.toString(),
      },
    );

    response.status(200).json({
      success: true,
      token,
      expiresIn: env.JWT_EXPIRES_IN,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
      business: {
        id: business._id.toString(),
        name: business.name,
      },
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", authenticate, async (request, response, next) => {
  const claims = request.auth;

  if (!claims) {
    response.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  try {
    const user = await User.findOne({ _id: claims.userId, businessId: claims.businessId });
    const business = await Business.findOne({
      _id: claims.businessId,
      ownerUserId: claims.userId,
    });

    if (!user || !business || user.role !== claims.role) {
      response.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    response.status(200).json({
      success: true,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
      business: {
        id: business._id.toString(),
        name: business.name,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default authRouter;

import express from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { env } from "./config/env.js";
import errorHandler from "./middleware/error-handler.js";
import authRouter from "./routes/v1/auth.routes.js";
import healthRouter from "./routes/v1/health.routes.js";

const app = express();

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (origin === undefined || origin === env.FRONTEND_ORIGIN) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
};

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  handler: (_request, response) => {
    response.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
  },
});

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "100kb" }));
app.use("/api/v1/auth", apiRateLimiter, authRouter);
app.use("/api/v1", apiRateLimiter, healthRouter);

app.use((_request, response) => {
  response.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use(errorHandler);

export default app;

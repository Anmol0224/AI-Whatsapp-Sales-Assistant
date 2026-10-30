import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/health", (_request, response) => {
  response.status(200).json({
    success: true,
    message: "Backend is running successfully",
    service: "WhatsApp Sales Assistant API",
  });
});

export default healthRouter;

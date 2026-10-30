import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: "whatsapp_sales_assistant",
  });
  console.log("MongoDB connected successfully to whatsapp_sales_assistant");
}

import app from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";

async function startServer(): Promise<void> {
  try {
    await connectDatabase();
  } catch {
    console.error("MongoDB connection failed. Verify MONGODB_URI and Atlas network access.");
    process.exit(1);
  }

  app.listen(env.PORT, () => {
    console.log(`WhatsApp Sales Assistant API listening on port ${env.PORT}`);
  });
}

void startServer();

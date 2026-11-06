import { randomUUID } from "node:crypto";
import mongoose, { type ClientSession, Types } from "mongoose";
import { Business } from "../models/business.model.js";

/**
 * Commits a FAQ/catalog source mutation and rotates the owning business policy
 * fence atomically. Automatic-send reservations write the same Business row.
 */
export async function withAutomaticReplyPolicyMutation<T>(
  businessId: Types.ObjectId,
  mutate: (session: ClientSession) => Promise<T | null>,
): Promise<T | null> {
  const session = await mongoose.startSession();
  try {
    let result: T | null = null;
    await session.withTransaction(async () => {
      const changed = await mutate(session);
      if (changed === null) {
        result = null;
        return;
      }

      const businessUpdate = await Business.updateOne(
        { _id: businessId },
        {
          $set: { "aiSettings.automaticRepliesPolicyVersion": randomUUID() },
          $inc: { "aiSettings.automaticRepliesControlVersion": 1 },
        },
        { session, runValidators: true },
      ).exec();
      if (businessUpdate.matchedCount !== 1) {
        throw new Error("AUTOMATIC_REPLY_POLICY_BUSINESS_NOT_FOUND");
      }
      result = changed;
    });
    return result;
  } finally {
    await session.endSession();
  }
}

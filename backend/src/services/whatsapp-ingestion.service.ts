import mongoose, { Types, type UpdateQuery } from "mongoose";
import { z } from "zod";
import { Business } from "../models/business.model.js";
import { Conversation, type ConversationFields } from "../models/conversation.model.js";
import { Customer, type CustomerFields } from "../models/customer.model.js";
import { Message, type MessageFields } from "../models/message.model.js";

const phoneNumberSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/)
  .transform((value) => value.replace(/^\+/, ""));

const providerTimestampSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((seconds) => Number.isSafeInteger(seconds) && seconds >= 0)
  .transform((seconds) => new Date(seconds * 1000))
  .refine((timestamp) => Number.isFinite(timestamp.getTime()));

const textMessageSchema = z
  .object({
    from: phoneNumberSchema,
    id: z.string().trim().min(1).max(256),
    timestamp: providerTimestampSchema.optional(),
    type: z.literal("text"),
    text: z
      .object({
        body: z.string().trim().min(1).max(4096),
      })
      .passthrough(),
  })
  .passthrough();

const messageTypeSchema = z.object({ type: z.string() }).passthrough();
const envelopeObjectSchema = z.object({ object: z.string().optional() }).passthrough();
const supportedEnvelopeSchema = z
  .object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.unknown()) })
  .passthrough();
const entrySchema = z.object({ changes: z.array(z.unknown()).optional() }).passthrough();
const changeSchema = z
  .object({ field: z.string(), value: z.unknown() })
  .passthrough();
const messagesValueSchema = z
  .object({
    metadata: z
      .object({
        phone_number_id: z.string().trim().min(1).max(128).optional(),
      })
      .passthrough()
      .optional(),
    contacts: z.array(z.unknown()).optional(),
    messages: z.unknown().optional(),
    statuses: z.unknown().optional(),
  })
  .passthrough();
const statusSchema = z.object({
  id: z.string().trim().min(1).max(256),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  timestamp: providerTimestampSchema,
  errors: z.array(z.unknown()).max(10).optional(),
}).passthrough();
const providerErrorSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  title: z.string().trim().optional(),
}).passthrough();
const contactSchema = z
  .object({
    wa_id: phoneNumberSchema,
    profile: z
      .object({ name: z.string().trim().min(1).max(100).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface IncomingWhatsAppTextMessage {
  phoneNumberId?: string;
  phoneNumber: string;
  profileName?: string;
  providerMessageId: string;
  timestamp?: Date;
  text: string;
}

export type WhatsAppDeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface IncomingWhatsAppStatusUpdate {
  phoneNumberId?: string;
  providerMessageId: string;
  status: WhatsAppDeliveryStatus;
  timestamp: Date;
  providerErrorCode?: string;
  providerErrorTitle?: string;
}

export type ParsedWhatsAppPayload =
  | { kind: "malformed" }
  | { kind: "ignored" }
  | { kind: "events"; messages: IncomingWhatsAppTextMessage[]; statuses: IncomingWhatsAppStatusUpdate[] };

export type IngestionResult =
  | { kind: "malformed" }
  | { kind: "ignored" }
  | { kind: "accepted"; inserted: number; duplicates: number };

export interface WhatsAppIngestionRepository {
  resolveBusinessId(phoneNumberId: string): Promise<string | null>;
  persistIncomingTextMessage(
    businessId: string,
    message: IncomingWhatsAppTextMessage,
  ): Promise<"inserted" | "duplicate" | "unmapped">;
  updateOutgoingMessageStatus(
    businessId: string,
    update: IncomingWhatsAppStatusUpdate,
  ): Promise<"updated" | "duplicate" | "stale" | "unknown">;
}

function getProfileName(contacts: unknown[] | undefined, phoneNumber: string): string | undefined {
  for (const contact of contacts ?? []) {
    const parsedContact = contactSchema.safeParse(contact);
    if (
      parsedContact.success &&
      parsedContact.data.wa_id === phoneNumber &&
      parsedContact.data.profile?.name
    ) {
      return parsedContact.data.profile.name;
    }
  }

  return undefined;
}

export function parseWhatsAppPayload(payload: unknown): ParsedWhatsAppPayload {
  const objectHeader = envelopeObjectSchema.safeParse(payload);
  if (!objectHeader.success) return { kind: "malformed" };
  if (objectHeader.data.object !== "whatsapp_business_account") return { kind: "ignored" };

  const envelope = supportedEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return { kind: "malformed" };

  const messages: IncomingWhatsAppTextMessage[] = [];
  const statuses: IncomingWhatsAppStatusUpdate[] = [];
  let malformedEntry = false;

  for (const entryValue of envelope.data.entry) {
    const entry = entrySchema.safeParse(entryValue);
    if (!entry.success) continue;

    for (const changeValue of entry.data.changes ?? []) {
      const change = changeSchema.safeParse(changeValue);
      if (!change.success || change.data.field !== "messages") continue;

      const value = messagesValueSchema.safeParse(change.data.value);
      if (!value.success) { malformedEntry = true; continue; }

      const messageValues: unknown[] = value.data.messages === undefined
        ? []
        : (Array.isArray(value.data.messages) ? value.data.messages : (malformedEntry = true, []));
      for (const messageValue of messageValues) {
        const messageType = messageTypeSchema.safeParse(messageValue);
        if (!messageType.success) { malformedEntry = true; continue; }
        if (messageType.data.type !== "text") continue;

        const textMessage = textMessageSchema.safeParse(messageValue);
        if (!textMessage.success) { malformedEntry = true; continue; }

        messages.push({
          phoneNumberId: value.data.metadata?.phone_number_id,
          phoneNumber: textMessage.data.from,
          profileName: getProfileName(value.data.contacts, textMessage.data.from),
          providerMessageId: textMessage.data.id,
          timestamp: textMessage.data.timestamp,
          text: textMessage.data.text.body,
        });
      }

      const statusValues: unknown[] = value.data.statuses === undefined
        ? []
        : (Array.isArray(value.data.statuses) ? value.data.statuses : (malformedEntry = true, []));
      for (const statusValue of statusValues) {
        const parsedStatus = statusSchema.safeParse(statusValue);
        if (!parsedStatus.success) { malformedEntry = true; continue; }
        const firstError = parsedStatus.data.errors?.[0];
        const parsedError = firstError === undefined ? undefined : providerErrorSchema.safeParse(firstError);
        const rawCode = parsedError?.success ? parsedError.data.code : undefined;
        const errorCode = rawCode === undefined ? undefined : String(rawCode).slice(0, 64);
        const errorTitle = parsedError?.success ? parsedError.data.title?.slice(0, 200) : undefined;
        statuses.push({
          phoneNumberId: value.data.metadata?.phone_number_id,
          providerMessageId: parsedStatus.data.id,
          status: parsedStatus.data.status,
          timestamp: parsedStatus.data.timestamp,
          ...(errorCode ? { providerErrorCode: errorCode } : {}),
          ...(errorTitle ? { providerErrorTitle: errorTitle } : {}),
        });
      }
    }
  }

  if (messages.length || statuses.length) return { kind: "events", messages, statuses };
  return malformedEntry ? { kind: "malformed" } : { kind: "ignored" };
}

interface MongooseStoredMessage {
  conversationId: Types.ObjectId;
  direction: string;
  text: string;
  timestamp?: Date;
  createdAt: Date;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

async function resolveBusinessId(phoneNumberId: string): Promise<string | null> {
  const matches = await Business.find({ "whatsapp.phoneNumberId": phoneNumberId })
    .select({ _id: 1 })
    .limit(2)
    .lean();

  return matches.length === 1 ? matches[0]._id.toString() : null;
}

async function findStoredMessage(
  businessId: string,
  providerMessageId: string,
): Promise<MongooseStoredMessage | null> {
  const message = await Message.findOne({ businessId, providerMessageId })
    .select({ conversationId: 1, direction: 1, providerMessageId: 1, text: 1, timestamp: 1, createdAt: 1 })
    .lean();

  return message;
}

async function persistIncomingTextMessage(
  businessId: string,
  incoming: IncomingWhatsAppTextMessage,
): Promise<"inserted" | "duplicate" | "unmapped"> {
  if (!incoming.phoneNumberId) return "unmapped";

  const businessObjectId = new Types.ObjectId(businessId);
  const duplicateFilter = { businessId: businessObjectId, providerMessageId: incoming.providerMessageId };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await mongoose.startSession();
    let result: "inserted" | "duplicate" | "unmapped" | undefined;

    try {
      await session.withTransaction(async () => {
        const business = await Business.findOne({
          _id: businessObjectId,
          "whatsapp.phoneNumberId": incoming.phoneNumberId,
        })
          .select({ _id: 1 })
          .session(session)
          .lean();

        if (!business) {
          result = "unmapped";
          return;
        }

        const existingMessage = await Message.findOne(duplicateFilter)
          .select({ _id: 1 })
          .session(session)
          .lean();
        if (existingMessage) {
          result = "duplicate";
          return;
        }

        const customerFilter = { businessId: businessObjectId, phoneNumber: incoming.phoneNumber };
        const customerUpdate: UpdateQuery<CustomerFields> = {
          $setOnInsert: { businessId: businessObjectId, phoneNumber: incoming.phoneNumber },
          ...(incoming.profileName ? { $set: { profileName: incoming.profileName } } : {}),
        };
        let customer = await Customer.findOneAndUpdate(customerFilter, customerUpdate, {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
          session,
        });
        if (!customer) throw new Error("Customer could not be resolved.");

        const conversationFilter = { businessId: businessObjectId, customerId: customer._id };
        let conversation = await Conversation.findOneAndUpdate(
          conversationFilter,
          {
            $setOnInsert: {
              businessId: businessObjectId,
              customerId: customer._id,
              status: "open",
            },
          },
          {
            new: true,
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            session,
          },
        );
        if (!conversation) throw new Error("Conversation could not be resolved.");

        const messageData: Omit<MessageFields, "createdAt" | "updatedAt"> = {
          businessId: businessObjectId,
          conversationId: conversation._id,
          customerId: customer._id,
          direction: "inbound",
          messageType: "text",
          text: incoming.text,
          providerMessageId: incoming.providerMessageId,
          status: "received",
          ...(incoming.timestamp ? { timestamp: incoming.timestamp } : {}),
        };
        const [createdMessage] = await Message.create([messageData], { session });

        const messageAt = createdMessage.timestamp ?? createdMessage.createdAt;
        const conversationIsCurrent =
          conversation.lastMessageAt === undefined || messageAt >= conversation.lastMessageAt;
        const conversationUpdate: UpdateQuery<ConversationFields> = {
          $set: {
            status: "open",
            ...(conversationIsCurrent
              ? {
                  lastMessageAt: messageAt,
                  lastMessagePreview: createdMessage.text.slice(0, 280),
                }
              : {}),
          },
        };
        const updateResult = await Conversation.updateOne(
          { _id: conversation._id, businessId: businessObjectId },
          conversationUpdate,
          { session, runValidators: true },
        );
        if (updateResult.matchedCount !== 1) {
          throw new Error("Conversation changed during message persistence.");
        }

        result = "inserted";
      });

      if (result) return result;
      throw new Error("Message transaction completed without a result.");
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const existing = await findStoredMessage(businessId, incoming.providerMessageId);
      if (existing) return "duplicate";
      if (attempt === 1) throw error;
    } finally {
      await session.endSession();
    }
  }

  throw new Error("Message persistence did not complete.");
}

const statusRank: Record<WhatsAppDeliveryStatus, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 0,
};

function sameDateFilter(date: Date | undefined): Record<string, unknown> {
  return date ? { providerStatusAt: date } : { providerStatusAt: { $exists: false } };
}

async function updateOutgoingMessageStatus(
  businessId: string,
  update: IncomingWhatsAppStatusUpdate,
): Promise<"updated" | "duplicate" | "stale" | "unknown"> {
  const filterBase = {
    businessId: new Types.ObjectId(businessId),
    providerMessageId: update.providerMessageId,
    direction: "outbound",
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await Message.findOne(filterBase as never)
      .select({ _id: 1, status: 1, providerStatusAt: 1 })
      .lean<{ _id: Types.ObjectId; status: string; providerStatusAt?: Date }>();
    if (!current) return "unknown";

    const currentStatus = current.status as WhatsAppDeliveryStatus;
    const currentAt = current.providerStatusAt;
    if (currentStatus === "failed" || (currentAt && update.timestamp < currentAt)) return "stale";

    const advancing = statusRank[update.status] > statusRank[currentStatus];
    const equalTimestampAdvance = currentAt?.getTime() === update.timestamp.getTime() && advancing;
    const newerTimestamp = !currentAt || update.timestamp > currentAt;
    const sameStatusNewer = update.status === currentStatus && newerTimestamp;
    const failureCanReplaceSent = update.status === "failed" && currentStatus === "sent" &&
      (!currentAt || update.timestamp >= currentAt);

    if (!advancing && !sameStatusNewer && !failureCanReplaceSent && !equalTimestampAdvance) return "duplicate";

    const nextStatus = failureCanReplaceSent ? "failed" : advancing ? update.status : currentStatus;
    const set: Record<string, unknown> = { status: nextStatus, providerStatusAt: update.timestamp };
    if (nextStatus === "failed") {
      if (update.providerErrorCode) set.providerErrorCode = update.providerErrorCode;
      if (update.providerErrorTitle) set.providerErrorTitle = update.providerErrorTitle;
    }
    const result = await Message.updateOne(
      {
        ...filterBase,
        status: current.status,
        ...sameDateFilter(currentAt),
      } as never,
      { $set: set },
      { runValidators: true },
    );
    if (result.modifiedCount === 1) return "updated";
  }

  throw new Error("Outgoing message status changed concurrently.");
}

const mongooseRepository: WhatsAppIngestionRepository = {
  resolveBusinessId,
  persistIncomingTextMessage,
  updateOutgoingMessageStatus,
};

export async function ingestWhatsAppPayload(
  payload: unknown,
  repository: WhatsAppIngestionRepository = mongooseRepository,
): Promise<IngestionResult> {
  const parsed = parseWhatsAppPayload(payload);
  if (parsed.kind !== "events") return parsed;

  let inserted = 0;
  let duplicates = 0;
  let recognizedStatus = false;
  const resolved = new Map<string, string | null>();

  for (const message of parsed.messages) {
    if (!message.phoneNumberId) continue;
    let businessId = resolved.get(message.phoneNumberId);
    if (businessId === undefined) {
      businessId = await repository.resolveBusinessId(message.phoneNumberId);
      resolved.set(message.phoneNumberId, businessId);
    }
    if (!businessId) continue;

    const persistenceResult = await repository.persistIncomingTextMessage(businessId, message);
    if (persistenceResult === "inserted") inserted += 1;
    else if (persistenceResult === "duplicate") duplicates += 1;
  }

  for (const status of parsed.statuses) {
    if (!status.phoneNumberId) continue;
    let businessId = resolved.get(status.phoneNumberId);
    if (businessId === undefined) {
      businessId = await repository.resolveBusinessId(status.phoneNumberId);
      resolved.set(status.phoneNumberId, businessId);
    }
    if (!businessId) continue;
    const statusResult = await repository.updateOutgoingMessageStatus(businessId, status);
    if (statusResult !== "unknown") recognizedStatus = true;
  }

  return inserted + duplicates > 0 || recognizedStatus
    ? { kind: "accepted", inserted, duplicates }
    : { kind: "ignored" };
}

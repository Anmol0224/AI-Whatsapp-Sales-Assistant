import assert from "node:assert/strict";
import test from "node:test";
import mongoose, { Types } from "mongoose";
import {
  createAutomaticReplySafetyRepository,
  createAutomaticReplySafetyService,
} from "../dist/services/automatic-reply-safety.service.js";

const businessId = new Types.ObjectId();
const conversationId = new Types.ObjectId();
const inboundMessageId = new Types.ObjectId();
const policyVersion = "test-policy-v1";
const controlVersion = 4;

async function readNestedPolicy(nestedBusiness, session) {
  const originalExec = mongoose.Query.prototype.exec;
  let observedQuery = false;
  mongoose.Query.prototype.exec = async function (...args) {
    assert.equal(this.model?.modelName, "Business");
    assert.deepEqual(this.getFilter(), { _id: businessId });
    assert.deepEqual(this._fields, {
      "aiSettings.automaticRepliesEnabled": 1,
      "aiSettings.automaticRepliesPolicyVersion": 1,
    });
    if (session) assert.equal(this.getOptions().session, session);
    observedQuery = true;
    return nestedBusiness;
  };

  try {
    const repository = createAutomaticReplySafetyRepository(session);
    const result = await repository.findBusinessPolicy(businessId);
    assert.equal(observedQuery, true);
    return result;
  } finally {
    mongoose.Query.prototype.exec = originalExec;
  }
}

test("business policy repository maps nested opted-in settings and preserves transaction session", async () => {
  const session = { marker: "session" };
  const policy = await readNestedPolicy({
    aiSettings: {
      automaticRepliesEnabled: true,
      automaticRepliesPolicyVersion: policyVersion,
    },
  }, session);

  assert.deepEqual(policy, {
    automaticRepliesEnabled: true,
    automaticRepliesPolicyVersion: policyVersion,
  });
});

test("business policy repository maps nested opted-out settings", async () => {
  const policy = await readNestedPolicy({
    aiSettings: {
      automaticRepliesEnabled: false,
      automaticRepliesPolicyVersion: policyVersion,
    },
  });

  assert.deepEqual(policy, {
    automaticRepliesEnabled: false,
    automaticRepliesPolicyVersion: policyVersion,
  });
});

test("missing business AI settings map to an opt-out and fail closed in validation", async () => {
  const policy = await readNestedPolicy({ aiSettings: null });
  assert.deepEqual(policy, {
    automaticRepliesEnabled: undefined,
    automaticRepliesPolicyVersion: undefined,
  });

  const service = createAutomaticReplySafetyService({
    repository: {
      async findBusinessPolicy() { return policy; },
      async findConversation() {
        return {
          _id: conversationId,
          businessId,
          responseMode: "ai_automatic",
          aiControlVersion: controlVersion,
        };
      },
      async findInboundMessage() {
        return {
          _id: inboundMessageId,
          businessId,
          conversationId,
          direction: "inbound",
          messageType: "text",
          text: "Synthetic validation input",
        };
      },
      async listActiveFaqs() { return []; },
      async listActiveCatalogItems() { return []; },
      async recordEscalation() { return { kind: "created", escalationId: new Types.ObjectId() }; },
    },
    isAutomaticSendEnabled: () => true,
    transactional: true,
    log: () => {},
  });

  const result = await service.validate({
    businessId,
    conversationId,
    inboundMessageId,
    expectedPolicyVersion: policyVersion,
    expectedControlVersion: controlVersion,
    generatedResponse: "Synthetic response",
  });
  assert.equal(result.decision, "policy_conflict");
  assert.equal(result.reasonCode, "automatic_replies_disabled");
});

test("missing Business document stays missing", async () => {
  assert.equal(await readNestedPolicy(null), null);
});

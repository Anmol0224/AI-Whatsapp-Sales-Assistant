import assert from 'node:assert/strict'
import test from 'node:test'
import { Types } from 'mongoose'
import { strictBooleanEnvSchema } from '../dist/config/strict-boolean-env.js'
import { AiReplyJob } from '../dist/models/ai-reply-job.model.js'
import { Business } from '../dist/models/business.model.js'
import { Conversation } from '../dist/models/conversation.model.js'
import {
  AUTOMATIC_REPLY_FOUNDATION_STEPS,
  parseMigrationArguments,
  validateMigrationTarget,
} from '../scripts/migrations/phase-7-3-2-automatic-reply-foundation.mjs'

test('new conversations default to Human and accept each target mode', async () => {
  const base = { businessId: new Types.ObjectId(), customerId: new Types.ObjectId() }
  const defaultConversation = new Conversation(base)
  assert.equal(defaultConversation.responseMode, 'human')
  assert.equal(defaultConversation.aiControlVersion, 0)

  for (const responseMode of ['ai_draft', 'ai_automatic']) {
    const conversation = new Conversation({ ...base, responseMode })
    await conversation.validate()
    assert.equal(conversation.responseMode, responseMode)
  }
})

test('legacy ai remains a valid draft-only stored value until the migration is coordinated', async () => {
  const conversation = new Conversation({
    businessId: new Types.ObjectId(),
    customerId: new Types.ObjectId(),
    responseMode: 'ai',
  })
  await conversation.validate()
  assert.equal(conversation.responseMode, 'ai')
})

test('business automatic reply opt-in defaults false and existing AI settings are preserved', () => {
  const common = { ownerUserId: new Types.ObjectId(), name: 'Synthetic foundation business' }
  const business = new Business(common)
  assert.equal(business.aiSettings?.automaticRepliesEnabled, false)

  const existingSettings = new Business({
    ...common,
    aiSettings: {
      enabledByDefault: true,
      modelIdentifier: 'existing-model-setting',
      contextMessageLimit: 8,
      communicationPreferences: 'existing preference',
    },
  })
  assert.equal(existingSettings.aiSettings?.automaticRepliesEnabled, false)
  assert.equal(existingSettings.aiSettings?.enabledByDefault, true)
  assert.equal(existingSettings.aiSettings?.modelIdentifier, 'existing-model-setting')
  assert.equal(existingSettings.aiSettings?.contextMessageLimit, 8)
  assert.equal(existingSettings.aiSettings?.communicationPreferences, 'existing preference')
  assert.equal(existingSettings.aiSettings?.automaticRepliesEnabledAt, undefined)
  assert.equal(existingSettings.aiSettings?.automaticRepliesEnabledByUserId, undefined)
})

test('existing AI reply jobs default to draft workflow without changing their status', () => {
  const job = new AiReplyJob({
    businessId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    inboundMessageId: new Types.ObjectId(),
    status: 'sending',
    approvedText: 'Previously owner-approved text',
  })
  assert.equal(job.workflow, 'ai_draft')
  assert.equal(job.status, 'sending')
  assert.equal(job.approvedText, 'Previously owner-approved text')
  assert.equal(job.sendProvenance, undefined)
})

test('automatic-send safety metadata is bounded to explicit schema enums', async () => {
  const job = new AiReplyJob({
    businessId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    inboundMessageId: new Types.ObjectId(),
    workflow: 'ai_automatic',
    sendProvenance: 'automatic_policy',
    automaticReplyTextSnapshot: 'Synthetic reply',
    automaticSafetyDecision: 'eligible',
    escalationReason: 'unsupported_query',
    automaticPolicyVersion: 'policy.v1',
    workflowControlVersion: 3,
  })
  await job.validate()
  assert.equal(job.workflow, 'ai_automatic')
  assert.equal(job.automaticSafetyDecision, 'eligible')
  assert.equal(job.escalationReason, 'unsupported_query')
  assert.equal(job.workflowControlVersion, 3)
})

test('global automatic-send gate accepts strict true/false strings and defaults false', () => {
  assert.equal(strictBooleanEnvSchema.parse(undefined), false)
  assert.equal(strictBooleanEnvSchema.parse('false'), false)
  assert.equal(strictBooleanEnvSchema.parse('true'), true)
  assert.equal(strictBooleanEnvSchema.parse(' TRUE '), true)
  for (const invalid of ['1', '0', 'yes', 'enabled', true, false]) {
    assert.equal(strictBooleanEnvSchema.safeParse(invalid).success, false)
  }
})

test('migration maps only legacy ai and missing opt-in/workflow fields', () => {
  assert.deepEqual(AUTOMATIC_REPLY_FOUNDATION_STEPS, [
    {
      name: 'legacy-ai-conversations-to-ai-draft',
      collection: 'conversations',
      filter: { responseMode: 'ai' },
      update: { $set: { responseMode: 'ai_draft' } },
    },
    {
      name: 'default-business-automatic-replies-off',
      collection: 'businesses',
      filter: { 'aiSettings.automaticRepliesEnabled': { $exists: false } },
      update: { $set: { 'aiSettings.automaticRepliesEnabled': false } },
    },
    {
      name: 'legacy-jobs-to-draft-workflow',
      collection: 'aireplyjobs',
      filter: { workflow: { $exists: false } },
      update: { $set: { workflow: 'ai_draft' } },
    },
  ])
  assert.ok(AUTOMATIC_REPLY_FOUNDATION_STEPS.every((step) => !('status' in step.update.$set)))
})

test('migration is dry-run by default and requires exact explicit apply confirmation', () => {
  assert.deepEqual(parseMigrationArguments([]), {
    mode: 'dry-run',
    confirmDatabase: undefined,
    confirmProductionDatabase: false,
  })
  assert.deepEqual(parseMigrationArguments(['--apply', '--confirm-database', 'whatsapp_sales_assistant_test']), {
    mode: 'apply',
    confirmDatabase: 'whatsapp_sales_assistant_test',
    confirmProductionDatabase: false,
  })
  assert.throws(() => parseMigrationArguments(['--apply', '--dry-run']), /conflicting_migration_modes/)
  assert.throws(() => parseMigrationArguments(['--apply', '--confirm-database']), /database_confirmation_required/)
  const applyTest = parseMigrationArguments(['--apply', '--confirm-database', 'whatsapp_sales_assistant_test'])
  assert.doesNotThrow(() => validateMigrationTarget(applyTest, 'whatsapp_sales_assistant_test'))
  assert.throws(() => validateMigrationTarget(applyTest, 'different_database'), /database_name_confirmation_mismatch/)

  const applyProduction = parseMigrationArguments([
    '--apply',
    '--confirm-database',
    'whatsapp_sales_assistant',
  ])
  assert.throws(() => validateMigrationTarget(applyProduction, 'whatsapp_sales_assistant'), /production_database_requires_additional_confirmation/)
  applyProduction.confirmProductionDatabase = true
  assert.doesNotThrow(() => validateMigrationTarget(applyProduction, 'whatsapp_sales_assistant'))
})

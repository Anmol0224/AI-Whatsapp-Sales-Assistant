import assert from 'node:assert/strict'
import { test } from 'node:test'
import mongoose, { Types } from 'mongoose'
import { Business } from '../dist/models/business.model.js'
import { withAutomaticReplyPolicyMutation } from '../dist/services/automatic-reply-policy.repository.js'

test('FAQ/catalog policy mutation and business policy fence share one transaction', async () => {
  const businessId = new Types.ObjectId()
  const session = { async withTransaction(callback) { return callback() }, async endSession() {} }
  const originalStartSession = mongoose.startSession
  const originalUpdateOne = Business.updateOne
  const order = []
  try {
    mongoose.startSession = async () => session
    Business.updateOne = (filter, update, options) => {
      order.push('policy')
      assert.equal(filter._id.toString(), businessId.toString())
      assert.equal(options.session, session)
      assert.equal(typeof update.$set['aiSettings.automaticRepliesPolicyVersion'], 'string')
      assert.equal(update.$inc['aiSettings.automaticRepliesControlVersion'], 1)
      return { async exec() { return { matchedCount: 1 } } }
    }
    const result = await withAutomaticReplyPolicyMutation(businessId, async (transactionSession) => {
      order.push('source')
      assert.equal(transactionSession, session)
      return { id: 'mutated-source' }
    })
    assert.deepEqual(result, { id: 'mutated-source' })
    assert.deepEqual(order, ['source', 'policy'])
  } finally {
    mongoose.startSession = originalStartSession
    Business.updateOne = originalUpdateOne
  }
})

test('missing source record does not rotate the business policy version', async () => {
  const originalStartSession = mongoose.startSession
  const originalUpdateOne = Business.updateOne
  let businessWrites = 0
  try {
    mongoose.startSession = async () => ({
      async withTransaction(callback) { return callback() },
      async endSession() {},
    })
    Business.updateOne = () => { businessWrites += 1; throw new Error('must not run') }
    const result = await withAutomaticReplyPolicyMutation(new Types.ObjectId(), async () => null)
    assert.equal(result, null)
    assert.equal(businessWrites, 0)
  } finally {
    mongoose.startSession = originalStartSession
    Business.updateOne = originalUpdateOne
  }
})

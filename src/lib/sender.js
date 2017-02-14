'use strict'

const uuid = require('uuid')
const moment = require('moment')
const Client = require('ilp-core').Client
const debug = require('debug')('ilp:sender')
const deterministicUuid = require('aguid')
const crypto = require('crypto')
const toConditionUri = require('../utils/condition').toConditionUri
const cryptoHelper = require('../utils/crypto')
const base64url = require('../utils/base64url')

/**
 * @module Sender
 */

/**
 * Returns an ILP Sender to quote and pay for payment requests.
 *
 * @param  {LedgerPlugin} opts._plugin Ledger plugin used to connect to the ledger, passed to [ilp-core](https://github.com/interledgerjs/ilp-core)
 * @param  {Objct}  opts Plugin parameters, passed to [ilp-core](https://github.com/interledgerjs/ilp-core)
 * @param  {ilp-core.Client} [opts.client=create a new instance with the plugin and opts] [ilp-core](https://github.com/interledgerjs/ilp-core) Client, which can optionally be supplied instead of the previous options
 * @param  {Array}  [opts.connectors=[]] Array of connectors to use, specified by account name on the local ledger (e.g. "connie"). Some ledgers provide recommended connectors while others do not, in which case this would be required to send Interledger payments.
 * @param  {Number} [opts.maxHoldDuration=10] Maximum time in seconds to allow money to be held for
 * @param  {Number} [opts.defaultRequestTimeout=30] Default time in seconds that requests will be valid for
 * @param  {Buffer} [opts.uuidSeed=crypto.randomBytes(32)] Seed to use for generating transfer UUIDs
 * @return {Sender}
 */
function createSender (opts) {
  const client = opts.client || new Client(opts, {
    connectors: opts.connectors
  })

  const maxHoldDuration = opts.maxHoldDuration || 10
  const defaultRequestTimeout = opts.defaultRequestTimeout || 30
  const uuidSeed = (Buffer.isBuffer(opts.uuidSeed) ? opts.uuidSeed : crypto.randomBytes(32)).toString('hex')

  /**
   * Get a fixed source amount quote
   * @param {String} destinationAddress ILP Address of the receiver
   * @param {String|Number} sourceAmount Amount the sender wants to send
   * @returns {Promise.<String>} destinationAmount
   */
  function quoteSourceAmount (destinationAddress, sourceAmount) {
    if (!destinationAddress || typeof destinationAddress !== 'string') {
      return Promise.reject(new Error('Must provide destination address'))
    }
    if (!sourceAmount) {
      return Promise.reject(new Error('Must provide source amount'))
    }

    return client.connect()
      .then(() => client.quote({
        destinationAddress: destinationAddress,
        sourceAmount: String(sourceAmount)
      }))
      .then((quote) => {
        debug('got source amount quote response', quote)
        if (!quote) {
          throw new Error('Got empty quote response from the connector')
        }
        return String(quote.destinationAmount)
      })
  }

  /**
   * Get a fixed destination amount quote
   * @param {String} destinationAddress ILP Address of the receiver
   * @param {String} destinationAmount Amount the receiver should recieve
   * @returns {Promise.<String>} sourceAmount
   */
  function quoteDestinationAmount (destinationAddress, destinationAmount) {
    if (!destinationAddress || typeof destinationAddress !== 'string') {
      return Promise.reject(new Error('Must provide destination address'))
    }
    if (!destinationAmount) {
      return Promise.reject(new Error('Must provide destination amount'))
    }

    return client.connect()
      .then(() => client.quote({
        destinationAddress: destinationAddress,
        destinationAmount: String(destinationAmount)
      }))
      .then((quote) => {
        debug('got destination amount quote response', quote)
        if (!quote) {
          throw new Error('Got empty quote response from the connector')
        }
        return String(quote.sourceAmount)
      })
  }

  /**
   * Quote a request from a receiver
   * @param  {Object} paymentRequest Payment request generated by an ILP Receiver
   * @return {Promise.<PaymentParams>} Resolves with the parameters that can be passed to payRequest
   */
  function quoteRequest (request) {
    if (!request.address) {
      return Promise.reject(new Error('Malformed payment request: no address'))
    }
    if (!request.amount) {
      return Promise.reject(new Error('Malformed payment request: no amount'))
    }
    if (!request.condition) {
      return Promise.reject(new Error('Malformed payment request: no condition'))
    }

    return client.connect()
      .then(() => client.quote({
        destinationAddress: request.address,
        destinationAmount: request.amount
      }))
      .then((quote) => {
        debug('got quote response', quote)
        if (!quote) {
          throw new Error('Got empty quote response from the connector')
        }
        return {
          sourceAmount: String(quote.sourceAmount),
          connectorAccount: quote.connectorAccount,
          destinationAmount: String(request.amount),
          destinationAccount: request.address,
          destinationMemo: {
            data: request.data,
            expires_at: request.expires_at
          },
          expiresAt: moment.min([
            moment(request.expires_at),
            moment().add(maxHoldDuration, 'seconds')
          ]).toISOString(),
          executionCondition: request.condition
        }
      })
  }

  /**
   * Pay for a payment request. Uses a determinstic transfer id so that paying is idempotent (as long as ledger plugins correctly reject multiple transfers with the same id)
   * @param  {PaymentParams} paymentParams Respose from quoteRequest
   * @return {Promise.<String>} Resolves with the condition fulfillment
   */
  function payRequest (paymentParams) {
    // Use a deterministic transfer id so that paying is idempotent
    // Include the uuidSeed so that an attacker could not block our payments by squatting on the transfer id
    const transferId = deterministicUuid(uuidSeed + paymentParams.executionCondition)
    const payment = Object.assign(paymentParams, {
      uuid: transferId
    })

    let promiseFulfillmentListener
    debug('sending payment:', payment)
    return client.connect()
      .then(() => client.sendQuotedPayment(payment))
      .catch((err) => {
        if (err.name !== 'DuplicateIdError') {
          throw err
        }
      })
      .then(() => {
        promiseFulfillmentListener = new Promise((resolve, reject) => {
          // TODO just have one listener for the client
          const transferTimeout = setTimeout(() => {
            debug('transfer timed out')
            client.removeListener('outgoing_fulfill', fulfillmentListener)
            reject(new Error('Transfer expired, money returned'))
          }, moment(payment.expiresAt).diff(moment()))

          function fulfillmentListener (transfer, fulfillment) {
            if (transfer.executionCondition === payment.executionCondition) {
              debug('outgoing transfer fulfilled', fulfillment, transfer)
              clearTimeout(transferTimeout)
              client.removeListener('outgoing_fulfill', fulfillmentListener)
              resolve(fulfillment)
            }
          }
          // TODO disconnect from the client if there are no more listeners
          client.on('outgoing_fulfill', fulfillmentListener)
        })

        // If it's a duplicate, try getting the fulfillment for that transfer
        // TODO also get the fulfillment if a transfer is rejected because the condition has already been fulfilled by another transfer
        return Promise.resolve(client.getPlugin().getFulfillment(transferId))
      })
      .catch((err) => {
        // If the transfer hasn't yet been fulfilled we'll wait for the event in the next handler
        if (err.name === 'MissingFulfillmentError') {
          return null
        }
        throw err
      })
      .then((fulfillment) => {
        if (fulfillment) {
          debug('payment was already fulfilled: ' + fulfillment)
          return fulfillment
        }
        debug('payment sent', payment)
        return promiseFulfillmentListener
      })
  }

  /**
   * Create a payment request using a Pre-Shared Key (PSK).
   *
   * @param {Object} params Parameters for creating payment request
   * @param {String} params.destinationAmount Amount that should arrive in the recipient's account
   * @param {String} params.destinationAccount Target account's ILP address
   * @param {String} params.sharedSecret Shared secret for PSK protocol
   * @param {String} [params.id=uuid.v4()] Unique ID for the request (used to ensure conditions are unique per request)
   * @param {String} [params.expiresAt=30 seconds from now] Expiry of request
   * @param {Object} [params.data=null] Additional data to include in the request
   *
   * @return {Object} Payment request
   */
  function createRequest (params) {
    const paymentRequest = {
      address: params.destinationAccount,
      amount: params.destinationAmount,
      expires_at: params.expiresAt || moment().add(defaultRequestTimeout, 'seconds').toISOString()
    }

    paymentRequest.address += '.' + (params.id || uuid.v4())

    const sharedSecret = Buffer.from(params.sharedSecret, 'base64')
    const conditionPreimage = cryptoHelper.hmacJsonForPskCondition(paymentRequest, sharedSecret)
    const condition = toConditionUri(conditionPreimage)

    if (params.data) {
      paymentRequest.data = {
        blob: base64url(cryptoHelper.aesEncryptObject(params.data, sharedSecret))
      }
    }

    return Object.assign({}, paymentRequest, {
      condition
    })
  }

  /**
   * Disconnect from the ledger and stop listening for events.
   *
   * @return {Promise.<null>} Resolves when the sender is disconnected.
   */
  function stopListening () {
    return client.disconnect()
  }

  return {
    quoteSourceAmount,
    quoteDestinationAmount,
    quoteRequest,
    payRequest,
    createRequest,
    stopListening
  }
}

exports.createSender = createSender

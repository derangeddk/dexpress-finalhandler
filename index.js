/*!
 * finalhandler
 * Copyright(c) 2014-2022 Douglas Christopher Wilson
 * MIT Licensed
 * -------------------
 * dexpress-finalhandler
 * Copyright(c) 2022 Niels Roesen Abildgaard
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var debug = require('debug')('finalhandler')
var encodeUrl = require('encodeurl')
var onFinished = require('on-finished')
var parseUrl = require('parseurl')
var statuses = require('statuses')
var unpipe = require('unpipe')

/* istanbul ignore next */
var defer = typeof setImmediate === 'function'
  ? setImmediate
  : function (fn) { process.nextTick(fn.bind.apply(fn, arguments)) }
var isFinished = onFinished.isFinished

/**
 * Module exports.
 * @public
 */

module.exports = finalhandler

/**
 * Create a function to handle the final response.
 *
 * @param {Request} req
 * @param {Response} res
 * @param {Object} [options]
 * @return {Function}
 * @public
 */

function finalhandler (req, res, options) {
  var opts = options || {}

  // get error callback
  var { onerror, onservererror } = opts

  // get error transformer, transforms error before handling as error
  // this gives users a chance to transform errors to http-errors to
  // inform behavior
  var errortransform = opts.errortransform || ((err) => err);

  return function (err) {
    var headers
    var body
    var status

    // schedule onerror callback
    if (err && onerror) {
      defer(onerror, err, req, res)
    }

    var rawErr = err
    err = errortransform(err)

    // ignore 404 on in-flight response
    if (!err && headersSent(res)) {
      debug('cannot 404 after headers sent')
      return
    }

    // unhandled error
    if (err) {
      // respect status code from error
      status = getErrorStatusCode(err)

      if (status === undefined) {
        // fallback to status code on response
        status = getResponseStatusCode(res)
      } else {
        // TODO: why is this an `else` (only if status not undefined)?
        // respect headers from error
        headers = getErrorHeaders(err)
      }

      if ((!status || status >= 500) && onservererror) {
        onservererror(rawErr)
      }

      // get error message
      body = getErrorBody(err, status)
    } else {
      // not found
      status = 404
      body = { reason: 'Cannot ' + req.method + ' ' + encodeUrl(getResourceName(req)) }
    }

    debug('default %s', status)

    // cannot actually respond
    if (headersSent(res)) {
      debug('cannot %d after headers sent', status)
      req.socket.destroy()
      return
    }

    // send response
    send(req, res, status, headers, body)
  }
}

/**
 * Get headers from Error object.
 *
 * @param {Error} err
 * @return {object}
 * @private
 */

function getErrorHeaders (err) {
  if (!err.headers || typeof err.headers !== 'object') {
    return undefined
  }

  return { ...err.headers };
}

/**
 * Get message from Error object, fallback to status message.
 *
 * @param {Error} err
 * @param {number} status
 * @return {string}
 * @private
 */

function getErrorBody (err, status) {
  // TODO:
  // We want to respect http-errors, basically `expose` flag on whether we should add info in
  // error to output. I'd like to be able to throw a Zod error -> HTTP error with 400 -> good response
  // and in time just support more errors in the same pipeline
  // Maybe config for finalhandler? That can be given in via dexpress
  if(err.expose) {
    var body = { reason: err.message || statuses.message[status] };

    for (var key in err) {
      if([ 'message', 'reason', 'status', 'statusCode', 'expose' ].includes(key)) {
        continue;
      }
      body[key] = err[key];
    }

    return body;
  }

  return { reason: statuses.message[status] }
}

/**
 * Get status code from Error object.
 *
 * @param {Error} err
 * @return {number}
 * @private
 */

function getErrorStatusCode (err) {
  // check err.status
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 600) {
    return err.status
  }

  // check err.statusCode
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600) {
    return err.statusCode
  }

  return undefined
}

/**
 * Get resource name for the request.
 *
 * This is typically just the original pathname of the request
 * but will fallback to "resource" is that cannot be determined.
 *
 * @param {IncomingMessage} req
 * @return {string}
 * @private
 */

function getResourceName (req) {
  try {
    return parseUrl.original(req).pathname
  } catch (e) {
    return 'resource'
  }
}

/**
 * Get status code from response.
 *
 * @param {OutgoingMessage} res
 * @return {number}
 * @private
 */

function getResponseStatusCode (res) {
  var status = res.statusCode

  // default status code to 500 if outside valid range
  if (typeof status !== 'number' || status < 400 || status > 599) {
    status = 500
  }

  return status
}

/**
 * Determine if the response headers have been sent.
 *
 * @param {object} res
 * @returns {boolean}
 * @private
 */

function headersSent (res) {
  return typeof res.headersSent !== 'boolean'
    ? Boolean(res._header)
    : res.headersSent
}

/**
 * Send response.
 *
 * @param {IncomingMessage} req
 * @param {OutgoingMessage} res
 * @param {number} status
 * @param {object} headers
 * @param {string} message
 * @private
 */

function send (req, res, status, headers, body) {
  function write () {
    // response status
    res.statusCode = status
    res.statusMessage = statuses.message[status]

    // remove any content headers
    res.removeHeader('Content-Encoding')
    res.removeHeader('Content-Language')
    res.removeHeader('Content-Range')

    // response headers
    setHeaders(res, headers)

    // security headers
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    res.setHeader('X-Content-Type-Options', 'nosniff')

    if (req.method === 'HEAD') {
      res.send()
      return
    }

    res.send(body)
  }

  if (isFinished(req)) {
    write()
    return
  }

  // unpipe everything from the request
  unpipe(req)

  // flush the request
  onFinished(req, write)
  req.resume()
}

/**
 * Set response headers from an object.
 *
 * @param {OutgoingMessage} res
 * @param {object} headers
 * @private
 */

function setHeaders (res, headers) {
  if (!headers) {
    return
  }

  var keys = Object.keys(headers)
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    res.setHeader(key, headers[key])
  }
}

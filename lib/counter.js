'use strict';

var _ = require('lodash'),
    Q = require('q'),
    moment = require('moment'),
    timeGranularities = require('./constants').timeGranularities,
    utils = require('./utils'),
    lua = require('./lua');

// The default expiration times aim at having less than 800 counters for a
// given counter key (event) since the counter keys are stored with a specific
// timestamp. For example, second-based counters expire after 10 minutes which
// means that there will be 600 counter keys in the worst-case for a single
// event.
var defaultExpiration = {
  total: -1,
  year: -1,
  month:  10 * 365 * 24 * 60 * 60, // 10 years = 120 counters worst-case
  day:  2 * 365 * 24 * 60 * 60,    // 2 years = 730 counters worst-case
  hour:  31 * 24 * 60 * 60,        // 31 days = 744 counters worst-case
  minute:  12 * 60 * 60,           // 12 hours = 720 counters worst-case
  second:  10 * 60                 // 10 minutes = 600 counters worst-case
};
// BTW, good luck keeping your Redis server around for 10 years :-)

// Translate the "nice looking expiration times above to "real" keys that
// correspond to time granularities.
_.keys(defaultExpiration).forEach(function(key) {
  var newKey = timeGranularities[key];
  var value = defaultExpiration[key];
  delete defaultExpiration[key];
  defaultExpiration[newKey] = value;
});

var defaults = {
  timeGranularity: timeGranularities.none,
  expireKeys: true,
  expiration: defaultExpiration
};

var momentFormat = 'YYYYMMDDHHmmss';

/**
 * Convert the given granularity level into the internal representation (a
 * number).
 * @returns {module:constants~timeGranularities}
 * @private
 */
var parseTimeGranularity = function(timeGranularity) {
  timeGranularity = timeGranularities[timeGranularity];
  if (timeGranularity) return timeGranularity;
  else return timeGranularities.none;
};

/**
 * Creates a function that parses a list of Redis results and matches them up
 * with the given keyRange
 * @param {array} keyRange - The list of keys to match with the results.
 * @returns {function}
 * @private
 */
var createRangeParser = function(keyRange) {
  return function(results) {
    return _.zipObject(keyRange, utils.parseIntArray(results));
  };
};

/**
 * Creates a function that parses a list of Redis results and returns the total.
 * @returns {function}
 * @private
 */
var createRangeTotalParser = function() {
  return function(results) {
    return _.sum(utils.parseIntArray(results));
  };
};

/**
 * A timestamped event counter.
 *
 * The timestamped counter stores one or more Redis keys based on the given
 * event name and time granularity appends a timestamp to the key before
 * storing the key in Redis. The counter can then report an overall aggregated
 * count or a specific count for a time range, depending on the chosen
 * granularity of the timestamp.
 *
 * If no time granularity is chosen at creation time, the counter will work
 * just like a global counter for the given key, i.e. events will not be
 * timestamped.
 *
 * **Notice**: The constructor for this class is usually not called directly
 * but through the {@link RedisMetrics#counter} function.
 *
 * @param {RedisMetrics} metrics - An instance of a RedisMetrics client.
 * @param {string} key - The base key to use for this counter.
 * @param {Object} options - The options to use for this counter. The available
 *   options are specified in {@link RedisMetrics#counter}.
 * @class
 */
function TimestampedCounter(metrics, key, options) {
  this.metrics = metrics;
  this.key = 'c:' + key; // Pre-prend c to indicate it's a counter.
  this.options = options || {};
  _.defaults(this.options, _.cloneDeep(defaults));

  // Translate the expiration keys of the options.
  var _this = this;
  _.keys(this.options.expiration).forEach(function(key) {
    var newKey = timeGranularities[key];
    var value = _this.options.expiration[key];
    delete _this.options.expiration[key];
    _this.options.expiration[newKey] = value;
  });

  this.options.timeGranularity =
    parseTimeGranularity(this.options.timeGranularity);
}

/**
 * Return a list of Redis keys that are associated with this counter at the
 * current point in time and will be written to Redis.
 * @returns {Array}
 */
TimestampedCounter.prototype.getKeys = function() {
  // Always add the key itself.
  var keys = [this.key];

  // If no time granularity is chosen, the timestamped keys will not be used so
  // just return the default key.
  if (this.options.timeGranularity === timeGranularities.none) {
    return keys;
  }

  var now = moment.utc().format(momentFormat);
  for (var i = 1; i <= this.options.timeGranularity; i++) {
    keys.push(this.key + ':' + now.slice(0, i*2+2));
  }
  return keys;
};

/**
 * Finds the configured time to live for the given key.
 * @param {string} key - The full key (including timestamp) for the key to
 *   determine the ttl for.
 * @returns {number} Number of seconds that the key should live.
 */
TimestampedCounter.prototype.getKeyTTL = function(key) {
  if (!this.options.expireKeys) return -1;

  var timePart = key.replace(this.key, '').split(':')[1] || '';
  var timeGranularity = timeGranularities.none;
  switch (timePart.length) {
    case 4:
      timeGranularity = timeGranularities.year;
      break;
    case 6:
      timeGranularity = timeGranularities.month;
      break;
    case 8:
      timeGranularity = timeGranularities.day;
      break;
    case 10:
      timeGranularity = timeGranularities.hour;
      break;
    case 12:
      timeGranularity = timeGranularities.minute;
      break;
    case 14:
      timeGranularity = timeGranularities.second;
      break;
  }
  var ttl = this.options.expiration[timeGranularity];
  if (typeof ttl === 'undefined') ttl = defaultExpiration[timeGranularity];
  return ttl;
};

/**
 * Increments this counter with 1.
 *
 * For some use cases, it makes sense to pass in an event object to get more
 * precise statistics for a specific event. For example, when counting page
 * views on a page, it makes sense to increment a counter per specific page.
 * For this use case, the eventObj parameter is a good fit.
 *
 * @param {Object|string} [eventObj] - Extra event information used to
 *   determine what counter to increment.
 * @param {function} [callback] - Optional callback.
 * @returns {Promise} A promise that resolves to the results from Redis. Can
 *   be used instead of the callback function.
 * @since 0.1.0
 */
TimestampedCounter.prototype.incr = function(eventObj, callback) {
  return this.incrby(1, eventObj, callback);
};

/**
 * Increments this counter with the given amount.
 *
 * @param {number} amount - The amount to increment with.
 * @param {Object|string} [eventObj] - Extra event information used to
 *   determine what counter to increment. See {@link TimestampedCounter#incr}.
 * @param {function} [callback] - Optional callback.
 * @returns {Promise} A promise that resolves to the results from Redis. Can
 *   be used instead of the callback function.
 * @see {@link TimestampedCounter#incr}
 * @since 0.2.0
 */
TimestampedCounter.prototype.incrby = function(amount, eventObj, callback) {
  // The event object is optional so it might be a callback.
  if (_.isFunction(eventObj)) {
    callback = eventObj;
    eventObj = null;
  }
  if (eventObj) eventObj = String(eventObj);
  var deferred = Q.defer();
  var cb = utils.createRedisCallback(deferred, callback);
  this._incrby(amount, eventObj, cb);
  return deferred.promise;
};

var incrSingle = function(client, key, amount, eventObj, ttl, cb) {
  if (eventObj) {
    key += ':z';

    if (ttl > 0) {
      if (cb) client.eval(lua.zincrbyExpire, 1, key, amount, eventObj, ttl, cb);
      else client.eval(lua.zincrbyExpire, 1, key, amount, eventObj, ttl);
    }
    else {
      if (cb) client.zincrby(key, amount, eventObj, cb);
      else client.zincrby(key, amount, eventObj);
    }

  } else { // No event object

    if (ttl > 0) {
      if (cb) client.eval(lua.incrbyExpire, 1, key, amount, ttl, cb);
      else client.eval(lua.incrbyExpire, 1, key, amount, ttl);
    }
    else {
      if (cb) client.incrby(key, amount, cb);
      else client.incrby(key, amount);
    }
  }
};

TimestampedCounter.prototype._incrby = function(amount, eventObj, cb) {
  var keys = this.getKeys();
  // Optimize for the case where there is only a single key to increment.
  if (keys.length === 1) {
    var ttl = this.getKeyTTL(keys[0]);
    incrSingle(this.metrics.client, keys[0], amount, eventObj, ttl, cb);
  } else {
    var multi = this.metrics.client.multi();
    var _this = this;
    keys.forEach(function(key) {
      var ttl = _this.getKeyTTL(key);
      incrSingle(multi, key, amount, eventObj, ttl);
    });
    multi.exec(cb);
  }
};

/**
 * Returns the current count for this counter.
 *
 * If a specific time granularity is given, the value returned is the current
 * value at the given granularity level. Effectively, this provides a single
 * answer to questions such as "what is the count for the current day".
 *
 * **Notice**: Counts cannot be returned for a given time granularity if it was
 * not incremented at this granularity level in the first place.
 *
 * @example
 * myCounter.count(function(err, result) {
 *   console.log(result); // Outputs the global count
 * });
 * @example
 * myCounter.count('year', function(err, result) {
 *   console.log(result); // Outputs the count for the current year
 * });
 * @example
 * myCounter.count('year', '/foo.html', function(err, result) {
 *   // Outputs the count for the current year for the event object '/foo.html'
 *   console.log(result);
 * });
 *
 * @param {module:constants~timeGranularities} [timeGranularity='total'] - The
 *   granularity level to report the count for.
 * @param {string|object} [eventObj] - The event object. See
 *   {@link TimestampedCounter#incr} for more info on event objects.
 * @param {function} [callback] - Optional callback.
 * @returns {Promise} A promise that resolves to the result from Redis. Can
 *   be used instead of the callback function.
 * @since 0.1.0
 */
TimestampedCounter.prototype.count = function(
    timeGranularity, eventObj, callback) {
  var args = Array.prototype.slice.call(arguments);

  // Last argument is callback;
  callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;

  // Event object requires that the time granularity is specified, otherwise we
  // can't reliably distinguish between them because both the eventObj and time
  // granularity can be strings. I miss Python.
  eventObj = args.length > 1 ? args.pop() : null;

  // Still any arguments left? That's a time granularity.
  timeGranularity = args.length > 0 ? args.pop() : 'none';
  timeGranularity = parseTimeGranularity(timeGranularity);

  var deferred = Q.defer();
  var cb = utils.createRedisCallback(deferred, callback, utils.parseInt);
  this._count(timeGranularity, eventObj, cb);
  return deferred.promise;
};

TimestampedCounter.prototype._count = function(timeGranularity, eventObj, cb) {
  var theKey = this.getKeys()[timeGranularity];
  if (eventObj) {
    this.metrics.client.zscore(theKey + ':z', eventObj, cb);
  } else {
    this.metrics.client.get(theKey, cb);
  }
};

/**
 * Returns an object mapping timestamps to counts in the given time range at a
 * specific time granularity level.
 *
 * Notice: This function does not make sense for the "none" time granularity.
 *
 * @param {module:constants~timeGranularities} timeGranularity - The
 *   granularity level to report the count for.
 * @param {Date|Object|string|number} startDate - Start date for the range
 *   (inclusive). Accepts the same argument as the constructor of a
 *   {@link http://momentjs.com/|moment} date.
 * @param {Date|Object|string|number} [endDate=new Date()] - End date for the
 *   range (inclusive). Accepts the same arguments as the constructor of a
 *   {@link http://momentjs.com/|moment} date.
 * @param {string|object} [eventObj] - The event object. See
 *   {@link TimestampedCounter#incr} for more info on event objects.
 * @param {function} [callback] - Optional callback.
 * @returns {Promise} A promise that resolves to the result from Redis. Can
 *   be used instead of the callback function.
 * @since 0.1.0
 */
TimestampedCounter.prototype.countRange = function(
    timeGranularity, startDate, endDate, eventObj, callback) {
  timeGranularity = parseTimeGranularity(timeGranularity);
  if (_.isFunction(eventObj)) {
    callback = eventObj;
    eventObj = null;
  }
  else if (_.isFunction(endDate)) {
    callback = endDate;
    endDate = moment.utc();
  } else {
    endDate = endDate || moment.utc();
  }
  if (eventObj) eventObj = String(eventObj);

  // Save the report time granularity because it might change.
  var reportTimeGranularity = timeGranularity;

  // If the range granularity is total, fall back to the granularity specified
  // at the counter level and then add the numbers together when parsing the
  // result.
  if (timeGranularity === timeGranularities.total) {
    timeGranularity = this.options.timeGranularity;

    // If the rangeGranularity is still total, it does not make sense to report
    // a range for the counter and we throw an error.
    if (timeGranularity === timeGranularities.total) {
      throw new Error('total granularity not supported for this counter');
    }
  }

  var momentRange = utils.momentRange(startDate, endDate, timeGranularity);
  var _this = this;
  var keyRange = [];
  var momentKeyRange = [];

  // Create the range of keys to fetch from Redis as well as the keys to use in
  // the returned data object.
  momentRange.forEach(function(m) {
    // Redis key range
    var mKeyFormat = m.format(momentFormat).slice(0, timeGranularity*2+2);
    keyRange.push(_this.key + ':' + mKeyFormat);

    // Timestamp range. Use ISO format for easy parsing back to a timestamp.
    momentKeyRange.push(m.format());
  });

  var deferred = Q.defer();
  var parser = reportTimeGranularity === timeGranularities.total ?
    createRangeTotalParser() : createRangeParser(momentKeyRange);
  var cb = utils.createRedisCallback(deferred, callback, parser);

  this._countRange(keyRange, eventObj, cb);

  return deferred.promise;
};

TimestampedCounter.prototype._countRange = function(keys, eventObj, cb) {
  if (eventObj) {
    var multi = this.metrics.client.multi();
    keys.forEach(function(key) {
      multi.zscore(key + ':z', eventObj);
    });
    multi.exec(cb);
  } else {
    this.metrics.client.mget(keys, cb);
  }
};

/**
 * Parse a rank result from redis
 * @param  {array} rank In this format: [ 'foo', '39', 'bar', '13' ]
 * @return {object} In this format: [ { foo: 39 }, { bar: 13 } ]
 */
var rankParser = function(rank) {
  // groups the array for each second row
  rank = _.groupBy(rank, function(row, index) {
    return Math.floor(index / 2);
  });

  // transform the object into an array
  // and the values to integer
  return _.toArray(rank)
    .map(function(row) {
      var _row = {};
      _row[row[0]] = parseInt(row[1], 10);

      return _row;
    });
};


/**
 * Returns the current top elements for this counter.
 *
 * If a specific time granularity is given, the value returned is the current
 * value at the given granularity level. Effectively, this provides a single
 * answer to questions such as "what is the rank for the current day".
 *
 * @example
 * myCounter.top(function(err, result) {
 *   console.log(result); // Outputs the global rank
 * });
 * @example
 * myCounter.top('year', function(err, result) {
 *   console.log(result); // Outputs the rank for the current year
 * });
 *
 * @param {module:constants~timeGranularities} [timeGranularity='total'] - The
 *   granularity level to report the rank for.
 * @param {string} [direction] - Optional sort direction, can be "asc" or "desc"
 * @param {integer} [startingAt] - Optional starting row, default 0
 * @param {integer} [limit] - Optional number of results to return, default -1
 * @param {function} [callback] - Optional callback.
 * @returns {Promise} A promise that resolves to the result from Redis. Can
 *   be used instead of the callback function.
 * @since 0.1.1
 */
TimestampedCounter.prototype.top = function(
  timeGranularity, direction, startingAt, limit, callback) {
  var args = Array.prototype.slice.call(arguments);

  // Last argument is callback;
  callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;

  limit = args.length > 3 ? args.pop() : -1;
  startingAt = args.length > 2 ? args.pop() : 0;
  direction = args.length > 1 ? args.pop() : 'desc';

  if (['asc', 'desc'].indexOf(direction) === -1) {
    throw new Error(
      'The direction parameter is expected to be one between ' +
      '"asc" or "desc", got "' + direction + '".'
    );
  }

  timeGranularity = parseTimeGranularity(timeGranularity);

  var deferred = Q.defer();
  var cb = utils.createRedisCallback(deferred, callback, rankParser);
  this._top(timeGranularity, direction, startingAt, limit, cb);
  return deferred.promise;
};

TimestampedCounter.prototype._top = function(
  timeGranularity, direction, startingAt, limit, cb) {
  var theKey = this.getKeys()[timeGranularity];

  if (direction === 'asc') {
    return this.metrics.client.zrange(
      theKey + ':z',
      startingAt,
      limit,
      'WITHSCORES',
      cb
    );
  }

  this.metrics.client.zrevrange(
    theKey + ':z',
    startingAt,
    limit,
    'WITHSCORES',
    cb
  );
};

module.exports = TimestampedCounter;

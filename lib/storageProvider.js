var redis = require('redis');
var redisClient = {};
var logger = {};

storageProvider = function(redisAuth, loggerExternal, initializeCallback){
  logger = loggerExternal;

  redisClient = redis.createClient(params['redisPort'], params['redisHost']);

  redisClient.on('error'
    , function (err) {
      logger.log('error', 'Redis Connect Error', { error: err });
      initializeCallback(err, null);
    });

  redisClient.on("connect"
    , function () {
      setDatabase(params['redisDb'], initializeCallback);
    });
};

/*
Internal Functions
 */

var setDatabase = function(redisDB, callback) {
  redisClient.select(redisDB
    , function (err, res) {
      if (err) {
        callback(err, res);
      } else {
        testConnection(callback);
      }
    })
};

var testConnection = function (callback) {
  var redisTestUUID = require('uuid').v4();
  var key = 'test_' + redisTestUUID;
  var value = redisTestUUID;

  setValue(key, value, function (err, res) {
    if (err) {
      callback(err, res);
    } else {
      getValue(key, function (err, res) {
        if (res != redisTestUUID)
        {
          logger.log('error', 'Redis returned the incorrect value for redisTestUUID', { redisTestUUID: redisTestUUID, response: response });
          callback(new Error('Redis returned the incorrect value for redisTestUUID'), null);
        } else {
          callback(err, res);
        }
      });
    }
  });
}

var setValue = function (key, value, callback) {
  redisClient.set(key, value, callback);
}

var getValue = function (key, callback) {
  redisClient.get(key, value
    , function (err, res) {
      if (err)
      {
        logger.log('error', 'Error retrieving key: ' + key, {error: JSON.stringify(err)});
        callback(err, res);
      } else {
        callback(err, res);
      }
    });
}

var expireValue = function (key, expiration, callback) {
  redisClient.expire(key, expiration, function(err, res) {
    if (err)
    {
      logger.log('warn', 'Failed to set expiration on key: ' + key, {key: key, err: err, res: res, expires: expires});
      callback(err, res);
    } else {
      logger.log('silly', 'Set expiration ' + expiration + ' for key: ' + key, {key: key, expiration: expiration, res: res});
      callback(err, res);
    }
  });
}

var saveValue = function(key, value, expiration, callback) {
  setValue(key, value, function(err, res) {
    if (err)
    {
      logger.log('warn', 'Failed to save value for key: ' + key, {key: key, err: err, res: res});
      callback(err, res);
    } else {
      logger.log('silly', 'Saved value for key: ' + key, {key: key, res: res});
      if (expiration > 0) {
        setExpiration(key, expiration, callback);
      } else {
        callback(null, res);
      }
    }
  });
};

var setExpiration = function(key, expiration, callback)
{
  expireValue(key, expiration, callback);
};

/*
Public Functions
 */

storageProvider.prototype.get = function(key, callback) {
  getValue(key
    , function (err, res) {
      if (err) {
        callback(err, null);
      } else {
        var item = '';
        try {
          item = JSON.parse(res);
        } catch (err) {
          callback(err, null);
        } finally {
          callback(null, item);
        }
      }
    });
}

storageProvider.prototype.set = function(key, value, expiration, serialize, callback)
{
  if (arguments.length == 2) {
    expiration = -1;
    serialize = true;
    callback = null;
  }

  if (arguments.length == 3) {
    serialize = true;
    callback = null;
  }

  if (arguments.length == 4) {
    callback = null;
  }

  if (serialize == true)
  {
    value = JSON.stringify(value);
  }

  if (!value || value == '')
  {
    var err = new Error('Attempted to store empty value for key: ' + key);

    logger.log('warn', err, {key: key});
    if (callback) {
      callback(err, null);
    }
  } else {
    saveValue(key, value, expiration, function (err, res) {
      if (callback) {
        callback(err, res);
      }
    });
  }
};

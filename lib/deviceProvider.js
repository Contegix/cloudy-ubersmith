var keyPrefix = 'devices:';

var defaultDevice = {};
var defaultExpiration = -1;

deviceProvider = function(storageProvider, logHandler){};

/*
Internal Functions
 */
var get = function(key, callback) {
  storageProvider.get(keyPrefix + key
    , function(err, res) {
      handleStorageProviderResponse(err, res, key, callback);
    });
}

var set = function (key, value, expiration, callback)
{
  storageProvider.set(keyPrefix + key, value, defaultExpiration
    , function(err, res) {
        if (err)
        {
          logHandler.log('error', 'Could not save Device', {err: err, res: res});
          callback(err, null);
        } else {
          logHandler.log('silly', 'Saved Device ' + key, {key: key, expiration: expiration});
          callback(null, res);
        }
    });
}

var handleStorageProviderResponse = function(err, res, key, callback) {
  if (err) {
    logHandler.log('error', 'Could not retrieve item from storage provider key: ' + key, {res: res, err: err, key: key});
    callback(err, null);
  } else {
    logHandler.log('silly', 'Retrieved item from storage provider: ' + key, {key: key, res: res});
    callback(null, res);
  }
}

var findByDeviceID = function(id, callback) {
  get('deviceID:' + id, callback);
};

var findAllDevices = function(callback) {
  var async = require('async');
  redisClient.keys(keyPrefix + ':deviceID:*', function (err, deviceList) {
    if (err) {
      callback(err, null);
    } else {
      async.map(deviceList, function(deviceID, ) {
        findByDeviceID(deviceID, function(err, device) {
          if (err) {
            aSyncMapCallback(err,null);
          } else {
            aSyncMapCallback(null, JSON.parse(device));
          }
        });
      }, callback);
    }
  });
};

var saveDevice = function(device, callback) {
  device = devices[i];
  device.uuid = require('uuid').v4();
  device.created_at = new Date();
  _.defaults(device, defaultDevice);
  set('devices:deviceID:' + deviceID, device, function (err, res){
    if (err) {
      logHandler.log(('error', 'failed to save device', {err: err, res: res}));
      callback(err);
    } else {
      logHandler.log(('silly', 'saved device', {res: res}));
      callback(null);
    }
  });
}

var saveDeviceList = function(devices, callback) {
  var async = require('async');

  if( typeof(devices.length)=="undefined")
    devices = [devices];

  async.each(devices, 5, saveDevice, function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, 'OK');
      }
  });
};

/*
External Functions
 */
deviceProvider.prototype.findAll = findAllDevices;
deviceProvider.prototype.findById = findByDeviceID;
deviceProvider.prototype.save = saveDeviceList;
deviceProvider.prototype.getDefaults = function () {
  var _ = require('underscore');
  var response = {};
  return _.defaults(response, defaultDevice);
}

deviceProvider.prototype.setDefaults = function (newDefaults) {
  var _ = require('underscore');
  var response = {};
  defaultDevice = _.defaults(defaultDevice, newDefaults);
  return _.defaults(response, defaultDevice);
}

/* Lets bootstrap with dummy data */
new deviceProvider().save([
  {title: 'Post one', body: 'Body one', comments:[{author:'Bob', comment:'I love it'}, {author:'Dave', comment:'This is rubbish!'}]},
  {title: 'Post two', body: 'Body two'},
  {title: 'Post three', body: 'Body three'}
], function(error, devices){});

exports.deviceProvider = deviceProvider;
var redis = require('redis');
var cache_manager = require('cache-manager');
var redis_store = require('./redis_store');
var cache_redis = {};
var cache_multi = {};
var cache_memory = cache_manager.caching({store: 'memory', max: 1024*64 /*Bytes*/, ttl: 15 /*seconds*/});
var cache_primary = cache_memory;

var defaultExpiration = 90;
var enableRedisStore = true;
var useCache = true;

var events = require('events');
var util = require('util');
var ctxlog = require('contegix-logger');
var logger;
var _ = require('underscore');
var mgmtDomain = '';
var uberHost = '';
var redisClient = {};
var uberAuth = new Array();
var Emitter = new events.EventEmitter;

module.exports = function(params)
{
  var module = {};

  function initialize(initializeCallback) {
    logger = ctxlog('uberdata', params.logLevel,  params.logDir);

    if (!params)
    {
      module.raiseError('params required');
    }

    if(!params.uberAuth)
    {
      raiseError('uberAuth is a required parameter');
      return;
    }

    uberAuth = params['uberAuth'];

    if (!uberAuth.username)
    {
      raiseError('uberAuth.username is a required parameter');
      return;
    }

    if (!uberAuth.password)
    {
      raiseError('uberAuth.password is a required parameter');
      return;
    }

    if (!uberAuth.url)
    {
      raiseError('uberAuth.url is a required parameter');
      return;
    }

    if (!uberAuth.host)
    {
      raiseError('uberAuth.host is a required parameter');
      return;
    }

    if(!params.redisHost)
    {
      raiseError('redisHost is a required parameter');
      return;
    }

    if(!params.redisPort)
    {
      raiseError('redisPort is a required parameter');
      return;
    }

    if (!params.cacheTTL)
    {
      params['cacheTTL'] = defaultExpiration;
    } else {
      defaultExpiration = params['cacheTTL'];
    }

    if (!params.redisDb)
    {
      params['redisDb'] = 6;
    }

    if (!params.mgmtDomain)
    {
      params['mgmtDomain'] = 'mgmt.example.com';
    }

    mgmtDomain = params.mgmtDomain;
    uberHost = uberAuth.host;

    if (enableRedisStore) {
      cache_redis = cache_manager.caching({store: redis_store, ttl: params['cacheTTL'] /*seconds*/, host: params['redisHost'], db:  params['redisDb']+1, port: params['redisPort']});
      //cache_multi = cache_manager.multi_caching([cache_memory, cache_redis]);
      cache_primary = cache_redis;
    } else {
      cache_primary = cache_memory;
    }

    redisClient = redis.createClient(params['redisPort'], params['redisHost']);

    /*redisClient.on('error'
      , function (err) {
        if (err) {
          logger.log('error', 'Redis Connect Error', { error: JSON.stringify(err.message) });
        }
      });
    */
    redisClient.on('connect'
      , function () {
        logger.log('verbose', 'Redis Connected', {});
        setDatabase(params['redisDb'], function(err, reply) {
          if (err) {
            module.done = true
            Emitter.emit('configure.failed', params);
            initializeCallback(err, 'FAILED');
          } else {
            module.done = true
            Emitter.emit('configure.complete', params);
            initializeCallback(null, 'OK');
          }
        });
      });

    redisClient.on('end'
      , function () {
        logger.log('verbose', 'Redis Disconnected', {});
      });
  };

  var raiseError = function(message)
  {
    logger.log('error', 'raise error: ' + message, {});
    throw Error(message);
  };

  var start = function(params)
  {
    if (!module.done)
    {
      throw new Error('Start called before configure completed, aborting');
    }
    logger.log('info', 'Cache Warmup Started', {source: params.uberAuth.url, dest: params.redisHost + ':' + params.redisPort + '/' + params.redisDb});
    removeExistingData ('devices:*', { 'finish_event': 'removed.device.list', family: 'devices', token: 'list', value: ''});
    removeExistingData ('clients:*', { 'finish_event': 'removed.client.list', family: 'clients', token: 'list', value: ''});
    removeExistingData ('locations:*', { 'finish_event': 'removed.facility.list', method: 'device.facility_list', method_params: '', key: 'facility.list'});

    //removeExistingData ('devices:*', { 'finish_event': 'removed.device.list', method: 'device.list', method_params: '', key: 'device.list'});
    //removeExistingData ('clients:*', { 'finish_event': 'removed.client.list', method: 'client.list', method_params: '&short=0&inactive=0&active=1&billing_info=1', key: 'client.list'});
    //removeExistingData ('locations:*', { 'finish_event': 'removed.facility.list', method: 'device.facility_list', method_params: '', key: 'facility.list'});
  };

  var removeExistingData = function(keys, params) {
    logger.log('debug', 'Removing Existing Data', {keys: keys});
    purgeKeys(keys, function (err) {
      if (err) {
        logger.log('error', 'Failed to purge data', {keys: keys, err: err.message});
        raiseError(err);
      } else {
        logger.log('debug', 'Keys Purged');
        Emitter.emit(params['finish_event'], params['family'], params['token'], params['value'], function() { return;});
      }
    });
  }

  /*
  Redis Store Functions
  */

  var setDatabase = function(redisDB, callback) {
    logger.log('verbose', 'Selecting Redis Database', {redisDB: redisDB});
    redisClient.select(redisDB
      , function (err, res) {
        if (err) {
          logger.log('error', 'Could not select Redis DB', {redisDB: redisDB});
          callback(err, res);
        } else {
          logger.log('silly', 'Selected Database', {redisDB: redisDB});
          testConnection(callback);
        }
      })
  };

  var storeValue = function(key, value, expiration, storeValueCallback) {
    setValue(key, value, function(err, res) {
      if (err)
      {
        logger.log('warn', 'Failed to save value for key: ' + key, {key: key, err: err, res: res});
        storeValueCallback(err, res);
      } else {
        logger.log('silly', 'Saved value for key: ' + key, {key: key, res: res});
        if (expiration > 0) {
          setExpiration(key, expiration, storeValueCallback);
        } else {
          storeValueCallback(null, res);
        }
      }
    });
  };

  var testConnection = function (callback) {
    var redisTestUUID = require('uuid').v4();
    var key = 'test_' + redisTestUUID;
    var value = redisTestUUID;

    logger.log('verbose', 'Testing Redis Connection', {key: key, value: value});

    saveValue(key, value, true, defaultExpiration, function (err, res) {
      if (err) {
        logger.log('error', 'Could not setValue', {key: key, err: err.message});
        logger.log('verbose', 'Test Completed', {success: false});
        callback(err, res);
      } else {
        logger.log('silly', 'setValue Succeeded', {key: key});
        getValue(key, function (err, res) {
          if (res != redisTestUUID)
          {
            logger.log('error', 'Redis returned the incorrect value for redisTestUUID', { redisTestUUID: redisTestUUID, response: response });
            logger.log('verbose', 'Test Completed', {success: false});
            callback(new Error('Redis returned the incorrect value for redisTestUUID'), null);
          } else {
            logger.log('silly', 'getValue Succeeded', {key: key});
            logger.log('verbose', 'Test Completed', {success: true});
            callback(err, res);
          }
        });
      }
    });
  };

  var setValue = function (key, value, callback) {
    logger.log('silly', 'setting value', {key: key, value: value});
    redisClient.set(key, value,function(reply) {
      //if (reply == 'OK') {
        callback(null, reply);
      //} else {
      //  callback(new Error('could not set value: ' + reply), null);
      //}
    });
  };

  var getValue = function (key, callback) {
    if (!enableRedisStore)
    {
      logger.log('debug', 'Redis Store Disabled', {key: key});
      callback(new Error('Redis Store is Disabled'), null);
    } else {
      redisClient.get(key
        , function (err, res) {
          if (err)
          {
            logger.log('error', 'Error retrieving key: ' + key, {error: JSON.stringify(err)});
            callback(err, res);
          } else {
            logger.log('silly', 'Get Key Worked', {key: key});
            try {
              res = JSON.parse(res);
            } catch (e) {
              res = null;
              callback(e, null);
            } finally {
              callback(null, res);
            }
          }
        }
      );
    }
  };

  var setExpiration = function(key, expiration, expirationCallback)
  {
    logger.log('silly', 'Setting Expiration', {key: key, expiration: expiration});
    redisClient.expire(key, expiration, function(err, res) {
      if (err)
      {
        logger.log('warn', 'Failed to set expiration on key: ' + key, {key: key, err: err, res: res, expires: expires});
        expirationCallback(err, res);
      } else {
        logger.log('silly', 'Set expiration ' + expiration + ' for key: ' + key, {key: key, expiration: expiration, res: res});
        expirationCallback(err, res);
      }
    });
  };

  var purgeKeys = function(keys, purgeCallback)
  {
    logger.log('silly', 'removing ' + keys, {keys: keys, params: params});

    redisClient.keys(keys, function (err, keyList)
    {
      if (err)
      {
        purgeCallback(new Error('Could not remove existing data: ' + keys));
      } else {
        var async = require('async');
        async.each(keyList, function(key, iterateCallback) {
          logger.log('silly', 'removing key: ' + key);

          redisClient.del(key, function (err)
          {
            iterateCallback(err);
          });
        }, function(err) {
           purgeCallback(err);
        });
      }
    });
  };

  var saveValue = function(key, value, serialize, expiration, callback)

  {
    if (arguments.length <= 2)
    {
      serialize = true;
    }

    if (arguments.length <= 3)
    {
      expiration = defaultExpiration; /* Seconds */
    }

    if (arguments.length <= 4)
    {
      callback = function() { return; };
    }

    if (!enableRedisStore)
    {
      if (!callback || callback == null) {
        return;
      } else {
        callback(new Error('Redis Store Disabled'), null);
      }
    }

    if (serialize == true)
    {
      value = JSON.stringify(value);
    }

    if (!value || value == '')
    {
      logger.log('silly', 'Attempted to store empty value for key: ' + key, {key: key});
      return;
    }
    storeValue(key, value, expiration, callback);
  };

  var addValuetoSet = function(key, value, serialize)
  {
    if (!enableRedisStore)
    {
      callback(new Error('Redis Storage is Disabled'));
    } else {
      if (serialize == true)
      {
        value = JSON.stringify(value);
      }

      redisClient.sadd(key
        , value
        , function (err, res) {
          if (err)
          {
            logger.log('error', 'Failed to save value for set: ' + key, {key: key, err: err, res: res});
          } else {
            logger.log('silly', 'Saved value for set: ' + key, {key: key, res: res});
          }
        }
      );
    }
  };

/*
  End Redis Functions
*/
  var _handleClient = function(client, callback)
  {
    var clientID = client.clientid;
    if (client.company != 'REMOVED' && client.active == 1)
    {
      addValuetoSet('clients', client);
      saveValue('clients:' + clientID, client);
      getItemFromUbersmith('client.contact_list', '&client_id=' + clientID + '&metadata=1&contact_active=1', 'contact.list', function (err, contactList) {
        _.each(contactList, function(contact) {
          Emitter.emit('new.contact', contact);
        });
        callback(null, client);
      });
    }
    else
    {
      redisClient.del('clients:' + clientID);
      redisClient.del('clients:' + clientID + ':devices');
      redisClient.del('clients:' + clientID + ':contacts');
      redisClient.del('clients:' + clientID + ':tickets');
      callback(null, client);
    }
  };

  var _handleClientTickets = function(ticketList)
  {
    var clientID = _.uniq(_.pluck(ticketList, 'client_id'))[0];
    redisClient.del('clients:' + clientID + ':tickets', function (err, reply) {
      var tickets = _.values(ticketList);
      _.each(tickets, function (ticket)
      {
        addValuetoSet('clients:' + clientID + ':tickets', ticketList);
      });
    });
  };

  var _handleSingleDevice = function(device)
  {
    var deviceID = device.dev;
    var hostname = device.dev_desc;
    var JSONDevice = JSON.stringify(device);

    logger.log('debug', 'Saving single device', { deviceID: deviceID, hostname: hostname })
    saveValue('devices:' + deviceID, JSONDevice, false);

    if (hostname && hostname != 'null')
    {
      saveValue('devices:hostname:' + hostname + mgmtDomain, JSONDevice, false);
    }
  };

  var _handleDevice = function(device, callback)
  {
      var deviceID = device.dev;
      var deviceHostname = device.dev_desc || '';
      var async = require('async');

      logger.log('debug', 'handling device ' + deviceID + ' completed', {deviceID: deviceID, hostname: device.dev_desc + mgmtDomain})

      if (deviceHostname != '')
      {
        redisClient.del('devices:hostname:' + device.dev_desc, function (err, reply) {
          saveValue('devices:hostname:' + deviceHostname, device, true, -1, function (err, reply) {
            if (err)
            {
              logger.log('error', err, {err: err, deviceID: deviceID, hostname: device.dev_desc + mgmtDomain});
            }
          });
        });
      }

      redisClient.del('devices:deviceID:' + deviceID, function (err, reply) {
        saveValue('devices:deviceID:' + deviceID, device, true, -1, function(err, reply) {
          if (err)
          {
            logger.log('error', err, {err: err, deviceID: deviceID, hostname: device.dev_desc + mgmtDomain});
          }
        });
      });

      Emitter.emit('new.device', device);
      _handleDeviceSets(device, callback);
  };

  var _handleDeviceSets = function(device, callback)
  {
    var JSONDevice = JSON.stringify(device);
    var deviceID = device.dev;

    logger.log('debug', 'handling device sets', {deviceID: device.dev, hostname: device.dev_desc + mgmtDomain});

    addValuetoSet('devices:list', JSONDevice, false);
    addValuetoSet('devices:type_group:' + device.devtype_group_id, JSONDevice, false);
    addValuetoSet('devices:type:' + device.type_id, JSONDevice, false);

    if (device.rack_code && device.rack_code != 'null')
    {
      addValuetoSet('devices:locations:racks:' + device.rack_code, JSONDevice, false);
    }

    if (device.fac_id && device.fac_id != 'null')
    {
      addValuetoSet('devices:locations:facility:' + device.fac_id, JSONDevice, false);
      addValuetoSet('devices:locations:facility:' + device.fac_id + ':zone:' + device.zone_id, JSONDevice, false);
      addValuetoSet('devices:locations:facility:' + device.fac_id + ':zone:' + device.zone_id + ':cage:' + device.cage_id, JSONDevice, false);
      addValuetoSet('devices:locations:facility:' + device.fac_id + ':zone:' + device.zone_id + ':cage:' + device.cage_id + ':row:' + device.row_id, JSONDevice, false);
      addValuetoSet('devices:locations:facility:' + device.fac_id + ':zone:' + device.zone_id + ':cage:' + device.cage_id + ':row:' + device.row_id + ':rack:' + device.rack_id, JSONDevice, false);
      addValuetoSet('devices:locations:facility:' + device.fac_id + ':zone:' + device.zone_id + ':cage:' + device.cage_id + ':row:' + device.row_id + ':rack:' + device.rack_id + ':position:' + device.rack_pos, JSONDevice, false);
    }

    if (device.clientid && device.clientid != 'null')
    {
      addValuetoSet('devices:clientid:' + device.clientid, JSONDevice, false);
      addValuetoSet('clients:' + device.clientid + ':devices', JSONDevice, false);
    }
    callback(null, device);
  };

  var _handleContact = function(contact)
  {
    addValuetoSet('clients:' + contact.client_id + ':contacts', JSON.stringify(contact), false);
    saveValue('contacts:' + contact.contact_id, JSON.stringify(contact), false);
  };

  var _handleTicket = function(ticket)
  {
    var deviceID = ticket.device_id;
    var clientID = ticket.client_id;
    var ticketID = ticket.ticket_id;
    if (deviceID != 0)
    {
      getCachedItem('devices', 'deviceID', deviceID, function (err, device){
        if (device)
        {
          ticket.dev_desc = device.dev_desc;
        }
        var JSONTicket = JSON.stringify(ticket);
        saveValue('tickets:' + ticketID, JSONTicket, false);
        if (clientID != 0) {
          addValuetoSet('clients:' + clientID + ':tickets', JSONTicket, false);
        }
        addValuetoSet('devices:' + deviceID + ':tickets', JSONTicket, false);
        addValuetoSet('tickets:list', JSONTicket, false);
      });
    } else {
      var JSONTicket = JSON.stringify(ticket);
      saveValue('tickets:' + ticketID, JSONTicket, false);
      if (clientID != 0) {
        addValuetoSet('clients:' + clientID + ':tickets', JSONTicket, false);
      }
      addValuetoSet('tickets:list', JSONTicket, false);
    }
  };
  var _handleFacility = function(facility)
  {
    var facilityID = facility.id;
    var facilityName = facility['fac_name'];
    var facilityCode = (facility['fac_code'] == '') ? facility['fac_name'] : facility['fac_code'];
    var zoneList = facility.zones;

    saveValue('locations:facility:' + facilityID + ':name', facilityName);
    saveValue('locations:facility:' + facilityID + ':code', facilityCode);
    addValuetoSet('locations:facilities', { id: facilityID, name: facilityName, code: facilityCode });

    Object.keys(zoneList).forEach(function (zoneID)
    {
      var zone = zoneList[zoneID];
      var zoneName = zone.zone_name;
      var zoneCode = (zone['zone_code'] == '') ? zone['zone_code'] : zone['zone_code'];
      var cageList = zone['cages'];
      saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':name', zoneName);
      saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':code', zoneCode);
      addValuetoSet('locations:facility:' + facilityID + ':zones', { id: zoneID, name: zoneName, code: zoneCode });

      Object.keys(cageList).forEach(function (cageID)
      {
        var cage = cageList[cageID];
        var cageName = cage.cage_name;
        var cageCode = (cage.cage_code == '') ? cage.cage_name : cage.cage_code;
        var rowList = cage.rows;
        saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':name', cageName);
        saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':code', cageCode);
        addValuetoSet('locations:facility:' + facilityID + ':zone:' + zoneID + ':cages', { id: cageID, name: cageName, code: cageCode });

        Object.keys(rowList).forEach(function (rowID)
        {
          var row = rowList[rowID];
          var rowName = row.row_name;
          var rowCode = (row.row_code == '') ? row.cage_name : row.cage_code;
          var rackList = row.racks;
          saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':row:' + rowID + ':name', rowName);
          saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':row:' + rowID + ':code', rowCode);
          addValuetoSet('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':rows', { id: rowID, name: rowName, code: rowCode });

          Object.keys(rackList).forEach(function (rackID)
          {
            var rack = rackList[rackID];
            var rackName = rack.rack_name;
            var rackCode = (rack.rack_code == '') ? rack.rack_name : rack.rack_code;
            saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':row:' + rowID + ':rack:' + rackID + ':name', rackName);
            saveValue('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':row:' + rowID + ':rack:' + rackID + ':code', rackCode);
            addValuetoSet('locations:facility:' + facilityID + ':zone:' + zoneID + ':cage:' + cageID + ':row:' + rowID + ':racks', { id: rackID, name: rackName, code: rackCode });
          });
        });
      });
    });
  };

  var _handleClientList = function(clientList)
  {
    var async = require('async');
    logger.log('debug', 'ready.client.list', {});
    redisClient.del('clients');
    getAdmins(function(err, adminList){
      _.each(clientList, function(client) {
        if (client.salesperson != '0' && adminList[client.salesperson])
        {
          client.salesperson_name = adminList[client.salesperson].name || '';
          client.salesperson_email = adminList[client.salesperson].email || '';
        } else {
          client.salesperson_name = '';
          client.salesperson_email = '';
        }
        var list = _.values(clientList);

        async.eachLimit(list, 15
          , function(client, clientListCallback) {
              _handleClient(client, clientListCallback);
          }, function(err) {
            // When all devices are finished, let others know.
            logger.log('debug', 'finished handling client', {});
            Emitter.emit('client.list.complete', clientList);
          });
        Emitter.emit('new.client', client);
      });
    });
  };

  var _handleDeviceGroupList = function(deviceGroupList)
  {
    var devtype_group_id = _.uniq(_.pluck(deviceGroupList, 'devtype_group_id'))[0];
    logger.log('verbose', 'handling list for devtype_group_id', {devtype_group_id: devtype_group_id});
    redisClient.del('devices:type_group:' + devtype_group_id, function(err, reply) {
      logger.log('verbose', 'removed list', {devtype_group_id: devtype_group_id});
      _.each(deviceGroupList, function(device) {
        //logger.log('verbose', 'adding device to set', {devtype_group_id: devtype_group_id});
        addValuetoSet('devices:type_group:' + devtype_group_id, JSON.stringify(device), false);
      })
    });
  }

  var _handleDeviceList = function(deviceList)
  {
    var async = require('async');
    var _ = require('underscore');
    var list = _.values(deviceList);

    async.eachLimit(list, 15
      , function(device, deviceListCallback) {
          // Handle each device, emit new.device when done
          _handleDevice(device, deviceListCallback);
      }, function(err) {
        // When all devices are finished, let others know.
        logger.log('debug', 'finished handling devices', {});
        Emitter.emit('device.list.complete', deviceList);
      });

    // Tickets are handled after the devices are populated so some information
    // from the device can be added to the ticket
    removeExistingData ('tickets:*', { 'finish_event': 'removed.ticket.list', family: 'tickets', token: 'list', value: ''});
  };


  var _handleTypeList = function(typeList) {
    saveValue('device_types:list', typeList);
  };

  var _handleTicketList = function(ticketList) {
    logger.log('debug', 'ready.ticket.list', {});
    _.each(ticketList, function(ticket) {
      Emitter.emit('new.ticket', ticket);
    });
  };

  var _handleFacilityList = function(facilityList) {
    logger.log('debug', 'ready.facility.list', {});
    _.each(facilityList, function(facility) {
      Emitter.emit('new.facility', facility);
    });
  };
 /*
  var _retrieveKey = function(method, params, key) {
    if (arguments.length < 2)
    {
      params = '';
    }

    if(arguments.length < 3)
    {
      key = method;
    }

    logger.log('debug', 'retrieve key: ' + key, { method: method, params: params, key: key});
    var request = require('request');
    var uberOptions = {
      'url':uberAuth['url'] + '/?method=' + method + params,
      'auth': { 'user': uberAuth['username'],
        'pass': uberAuth['password'],
        'sendImmediately': true
      },
      json: true
    };

    request(uberOptions
      , function (err, res)
      {
        if (err)
        {
          logger.log('error', 'request failed with err: ' + err.message, {err: err, url: uberOptions['url'], event:'failed.' + key });
          Emitter.emit('failed.' + key, err);
        }
        else
        {
          var event = 'ready.' + key;
          logger.log('debug', 'request complete', {url: uberOptions['url'], event:event });
          if (Emitter.listeners(event).length < 1)
          {
            logger.log('error', 'no handler for event:' + event, {event: event, url:  uberOptions['url']});
          }
          if (res.body && res.body.data)
          {
            logger.log('debug', 'success ' + event, {event: event, url:  uberOptions['url']});
            Emitter.emit(event, res.body.data);
          } else {
            logger.log('warn', 'failed: ' + key, {key: key, url:  uberOptions['url']});
            logger.log('verbose', 'failed data', {body: JSON.stringify(res.body)});
            Emitter.emit('failed.' + key, new Error('failed to find data in res.body'));
          }

        }
      }
    );
  };
   */
// Methods below this point are for retrieving data from the Ubersmith Cache

// This construct identifies the information neccessary to take a family and key and get back the object(s)
// from Redis and Ubersmith
  var UberettaStone = {};

  UberettaStone['devices'] = {};
  UberettaStone['devices']['deviceID'] = {
    redis: { key: 'devices:deviceID:%token%', method: 'get'},
    ubersmith: { method: 'device.get', params: '&device_id=%token%&modules=1&require_ip=1&metadata=1', key: 'single.device'}
  };

  UberettaStone['devices']['clientID'] = {
    redis: { key: 'devices:clientid:%token%', method: 'smembers'},
    ubersmith: { method: 'device.list', params: '&client_id=%token%&modules=1&require_ip=1&metadata=1', key: 'client.devices'}
  };

  UberettaStone['devices']['hostname'] = {
    redis: { key: 'devices:hostname:%token%', method: 'get'},
    ubersmith: null
  };

  UberettaStone['devices']['list'] = {
    redis: { key: 'devices:list', method: 'smembers'},
    ubersmith: { method: 'device.list', params: '', key: 'device.list'}
  };

  UberettaStone['devices']['rack'] = {
    redis: { key: 'devices:locations:racks:%token', method: 'smembers'},
    ubersmith: null
  };

  UberettaStone['devices']['type_group'] = {
    redis: { key: 'devices:type_group:%token%', method: 'smembers'},
    ubersmith: { method: 'device.list', params: '&devtype_group_id=%token%&metadata=1&require_ip=1&modules=1', key: 'device.group_list'}
  };

  UberettaStone['comments'] = {};
  UberettaStone['comments']['list'] = {
    redis: { key: 'clients:comments:%token%', method: 'smembers'},
    ubersmith: { method: 'uber.comment_list', params: '&type=client&ref_id=%token%', key: 'uber.comment_list'}
  }

  UberettaStone['comments']['attachment'] = {
    redis: { key: 'clients:comments:attachment:%token%', method: 'smembers'},
    ubersmith: { method: 'uber.attachment_get', params: '&attach_type=comment&attach_id=%token%', key: 'uber.attachment'}
  }

  UberettaStone['comments']['attachments'] = {
    redis: { key: 'clients:comments:attachments:%token%', method: 'smembers'},
    ubersmith: { method: 'uber.attachment_list', params: '&attach_type=comment&id=%token%&comment_type=client', key: 'uber.attachment_list'}
  }

  UberettaStone['clients'] = {};
  UberettaStone['clients']['clientID'] = {
    redis: { key: 'clients:%token%', method: 'get'},
    ubersmith: { method: 'client.get', params: '&client_id=%token%&metadata=1&tags=1', key: 'single.client'}
  }

  UberettaStone['clients']['listAll'] = {
    redis: { key: 'clients', method: 'smembers'},
    ubersmith: { method: 'client.list', params: '&short=0&inactive=0&billing_info=1', key: 'client.list'}
  }

  UberettaStone['clients']['list'] = {
    redis: { key: 'clients', method: 'smembers'},
    ubersmith: { method: 'client.list', params: '&short=0&inactive=0&active=1&billing_info=1', key: 'client.list'}
  }

  UberettaStone['clients']['comments'] = {
    redis: { key: 'clients:comments:%token%', method: 'smembers'},
    ubersmith: { method: 'uber.comment_list', params: '&type=client&ref_id=%token%', key: 'uber.comment_list'}
  }

  UberettaStone['sales'] = {};
  UberettaStone['sales']['opportunity_list'] = {
    redis: { key: 'sales:opportunity_list', method: 'smembers'},
    ubersmith: { method: 'sales.opportunity_list', params: '%token%', key: 'sales.opportunity_list'}
  }

  UberettaStone['sales']['opportunity_status_list'] = {
    redis: { key: 'sales:opportunity_status_list', method: 'smembers'},
    ubersmith: { method: 'sales.opportunity_status_list', params: '', key: 'sales.opportunity_status_list'}
  }

  UberettaStone['sales']['opportunity_stage_list'] = {
    redis: { key: 'sales:opportunity_stage_list', method: 'smembers'},
    ubersmith: { method: 'sales.opportunity_stage_list', params: '', key: 'sales.opportunity_stage_list'}
  }

  UberettaStone['sales']['opportunity_type_list'] = {
    redis: { key: 'sales:opportunity_type_list', method: 'smembers'},
    ubersmith: { method: 'sales.opportunity_type_list', params: '', key: 'sales.opportunity_type_list'}
  }

  UberettaStone['clients']['files'] = {
    redis: { key: 'clients:files:%token%', method: 'smembers'},
    ubersmith: { method: 'uber.file_list', params: '&type=application/jsont&client_id=%token%', key: 'uber.client_file_list'}
  }

  UberettaStone['clients']['attachments'] = {
    redis: { key: 'clients:attachements', method: 'smembers'},
    ubersmith: { method: 'uber.attachment_list', params: '&attach_type=comment', key: 'uber.comment_attachment_list'}
  }

  UberettaStone['clients']['allfiles'] = {
    redis: { key: 'clients:files', method: 'smembers'},
    ubersmith: { method: 'uber.file_list', params: '', key: 'uber.client_file_list'}
  }

  UberettaStone['leads'] = {};
  UberettaStone['leads']['list'] = {
    redis: { key: 'leads', method: 'smembers'},
    ubersmith: { method: 'client.list', params: '&short=0&metadata=1&active=2&billing_info=1&order_by=listed_company', key: 'leads.list'}
  }

  UberettaStone['contacts'] = {};
  UberettaStone['contacts']['clientID'] = {
    redis: { key: 'clients:%token%:contacts', method: 'smembers'},
    ubersmith: { method: 'client.contact_list', params: '&client_id=%token%&metadata=1&tags=1', key: 'contact.list'}
  }

  UberettaStone['contacts']['contactID'] = {
    redis: { key: 'contacts:%token%', method: 'get'},
    ubersmith: { method: 'client.contact_get', params: '&contact_id=%token%', key: 'single.contact'}
  }

  UberettaStone['admins'] = {};
  UberettaStone['admins']['list'] = {
    redis: { key: 'admins', method: 'smembers'},
    ubersmith: { method: 'uber.admin_list', params: '', key: 'login.list'}
  }

  UberettaStone['admins']['methods'] = {
    redis: { key: 'admins:methods', method: 'smembers'},
    ubersmith: { method: 'uber.method_list', params: '', key: ''}
  }

  UberettaStone['device_types'] = {};
  UberettaStone['device_types']['list'] = {
    redis: { key: 'device_types:list', method: 'get'},
    ubersmith: { method: 'device.type_list', params: '',  key: 'type.list'}
  };

  UberettaStone['events'] = {};
  UberettaStone['events']['list'] = {
    redis: { key: 'events:list', method: 'smembers' },
    ubersmith: { method: 'uber.event_list', params: '', key: 'events.list'}
  }

  UberettaStone['tickets'] = {};
  UberettaStone['tickets']['list'] = {
    redis: { key: 'tickets:list', method: 'smembers' },
    ubersmith: { method: 'support.ticket_list', params: '&queue=1&metadata=1&type=ClientAll', key: 'tickets.list'}
  }
  UberettaStone['tickets']['ticketID'] = {
    redis: { key: 'tickets:%token%', method: 'get'},
    ubersmith: { method: 'support.ticket_get', params: '&ticket_id=%token%',  key: 'single.ticket'}
  };
  UberettaStone['tickets']['deviceID'] = {
    redis: { key: 'devices:%token%:tickets', method: 'smembers'},
    ubersmith: { method: 'support.ticket_list', params: '&queue=1&metadata=1&type=ClientAll&device_id=%token%',  key: 'device.tickets'}
  };
  UberettaStone['tickets']['clientID'] = {
    redis: { key: 'clients:%token%:tickets', method: 'smembers'},
    ubersmith: { method: 'support.ticket_list', params: '&queue=1&metadata=1&type=ClientAll&client_id=%token%',  key: 'client.tickets'}
  };
  UberettaStone['uber'] = {};
  UberettaStone['uber']['quick_stats'] = {
    redis: { key: 'ubersmith:stats:%token%', method: 'smembers'},
    ubersmith: { method: 'uber.quick_stats', params: '&timestamp=%token%',  key: 'uber.quick_stats'}
  };

  UberettaStone['ticket_posts'] = {};
  UberettaStone['ticket_posts']['ticketID'] = {
    redis: { key: 'tickets:%token%:posts', method: 'smembers'},
    ubersmith: { method: 'support.ticket_post_list', params: '&ticket_id=%token%',  key: 'ticket.posts'}
  };

  var replaceToken = function(str, value)
  {
    return str.replace('%token%', value);
  };

  var getItemListFromRedis = function(key, getItemListCallback) {
    redisClient.keys(key, function (err, keys) {
      if (keys.length > 0)
      {
        var async = require('async');
        async.mapLimit(keys, 20, getValue, getItemListCallback);
      } else {
        getItemListCallback(new Error('no keys found'), null);
      }

    });
  };

  var getItemFromRedis = function(key, getItemFromRedisCallback)
  {
    if (key == '')
    {
      getItemFromRedisCallback(new Error('invalid key'), null);
    } else if (!enableRedisStore) {
      getItemFromRedisCallback(new Error('Redis Storage is Disabled'), null);
    } else {
      getValue(key, function(err, reply) {
        if (!reply || reply == '[]' || reply == [] || reply == '' || reply == {}) {
          getItemFromRedisCallback(new Error('Redis returned empty item'), reply);
        } else {
          getItemFromRedisCallback(null, reply);
        }
      });
    }
  };

  var postItemToUbersmith = function(method, postData, callback)
  {
    var request = require('request');
    var querystring = require('querystring');
    //var postData = querystring.stringify(postData);

    var uberOptions = {
      'url':uberAuth['url'] + '/?method=' + method,
      'form': postData,
      'method': "POST",
      'timeout':30000,
      'headers': {
        'Host': uberHost,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.8; rv:24.0) Gecko/20100101',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
      },
      'followAllRedirects': true,
      'auth': { 'user': uberAuth['username'],
        'pass': uberAuth['password'],
        'sendImmediately': true
      }
    };

    request(uberOptions, function(error, response, body){
      var ret = '';
      try {
        if (Object.prototype.toString.call(body) === '[object String]') {
          ret = JSON.parse(body);
        } else {
          ret = body;
        }
      } catch (e) {
        callback({code: 500, message: 'Could not parse JSON', status: false, data: body, e: e.message }, null);
      } finally {
        callback(null, ret);
      }
    });
  };

  var addPostToTicket = function(ticketID, subject, body, visible, from, time_spent, callback) {
    var postData = {ticket_id: ticketID, subject: subject, body: body, visible: visible, from: from, time_spent: time_spent};
    postItemToUbersmith('support.ticket_post_staff_response', postData, callback);
  };

  var createNewTicket = function(body, subject, recipient, user_id, author, cc, to, priority, client_id, contact_id, device_id, callback) {
    var postData = {body: body, subject: subject, recipient: recipient, user_id: user_id, author: author, cc: cc, to: to, priority: priority, client_id: client_id, contact_id: contact_id, device_id: device_id};
    postItemToUbersmith('support.ticket_submit_outgoing', postData, callback);
  };

  var submitNewLead = function(first, last, company, email, address, city, state, zip, country, phone, callback) {
    var postData = {
      first: first,
      last: last,
      company: company,
      email: email,
      address: address,
      city: city,
      state: state,
      zip: zip,
      country: country,
      phone: phone,
      active: 2
    };
    postItemToUbersmith('client.add', postData, callback);
  }

  var submitComment = function(type, ref_id, comment, user_id, commentJSON, callback) {

    var uberOptions = {
      'url':uberAuth['url'] + '/?method=uber.comment_add',
      'method': "POST",
      'timeout':30000,
      'headers': {
        'Host': uberHost,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.8; rv:24.0) Gecko/20100101',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
      },
      'followAllRedirects': true,
      'auth': { 'user': uberAuth['username'],
        'pass': uberAuth['password'],
        'sendImmediately': true
      }
    };
    var request = require('request');
    var r = request.post(uberOptions, function(err, response, body) {
      if (err) {
        callback(err);
      } else {
        var ret = '';
        try {
          if (Object.prototype.toString.call(body) === '[object String]') {
            ret = JSON.parse(body);
          } else {
            ret = body;
          }
        } catch (e) {
          callback({code: 500, message: 'Could not parse JSON', status: false, data: body, e: e.message }, null);
        } finally {
          callback(null, ret);
        }
      }
    });
    var form = r.form();
    form.append('type', type);
    form.append('ref_id', ref_id);
    form.append('comment', comment);
    form.append('user_id', 61);
    form.append('attach[0]', new Buffer(commentJSON), {contentType: 'application/json', filename: require('uuid').v4() + '.json'});
  };

  var ubersmithRequest = function(uberOptions, ubersmithRequestCallback) {
    if (useCache) {
      cache_memory.wrap(uberOptions.url, function(cacheCallback) {
        var request = require('request');
        request(uberOptions, function(err, res, body) {
          cacheCallback(err, res, body);
        });
      }, ubersmithRequestCallback);
    } else {
      var request = require('request');
      request(uberOptions, ubersmithRequestCallback);
    }

  };

  var getItemFromUbersmith = function(method, params, key, getUSItemCallback)
  {
    var url = uberAuth['url'] + '/?method=' + method + params;
    var uberOptions = {
      'url': url,
      'auth': { 'user': uberAuth['username'],
        'pass': uberAuth['password'],
        'sendImmediately': true
      },
      json: true
    };

    ubersmithRequest(uberOptions
      , function (err, res, body)
      {
        if (err)
        {
          logger.log('error', 'request failed with err: ' + err.message, {err: JSON.stringify(err), url: uberOptions['url'], event:'failed.' + key });
          Emitter.emit('failed.' + key, err);
          getUSItemCallback(err, null);
        }
        else
        {
          var event = 'ready.' + key;
          logger.log('debug', 'request complete', {url: uberOptions['url'], event:event });
          if (res.body && res.body.data)
          {
            logger.log('debug', 'success ' + event, {event: event, url:  uberOptions['url']});
            //Emitter.emit(event, res.body.data);
            getUSItemCallback(null, res.body.data);
          } else if (body) {
            getUSItemCallback(null, body);
          } else {
            logger.log('warn', 'failed: ' + key, {key: key, url:  uberOptions['url']});
            logger.log('verbose', 'failed data', {body: JSON.stringify(res.body)});
            getUSItemCallback({code: res.body.error_code, message: res.body.error_message}, null);
            //Emitter.emit('failed.' + key, new Error('failed to find data in res.body'));
          }
        }
      }
    );
  };

  var getCachedItem = function(family, token, value, getCachedItemCallback) {
    var key = JSON.stringify({family: family, token: token, value: value});
    if (useCache) {
      logger.log('debug', 'Attempting to get Cached Item', {item: key});
      cache_primary.wrap(key, function(cacheCallback) {
        getItemKey(key, cacheCallback);
      }, getCachedItemCallback);
    } else {
      getItemKey(key, getCachedItemCallback);
    }
  }

  var getItem = function(family, token, value, getItemCallback) {
    var key = JSON.stringify({family: family, token: token, value: value});
    logger.log('debug', 'Attempting to get Item', {item: key});
    getItemKey(key, getItemCallback);
  };

  var getItemKey = function(itemKey, getItemKeyCallback) {
    itemKey = JSON.parse(itemKey);
    var family = itemKey.family;
    var token = itemKey.token;
    var value = itemKey.value;
    logger.log('debug', 'Attempting to get Item with Key', {key: itemKey});
    if (UberettaStone[family] && UberettaStone[family][token]) {
      var translationTable = UberettaStone[family][token];
      var async = require('async')
      // Using Waterfall backwards, error = good;
      async.waterfall([
        function(waterfallCallback) {
          if (enableRedisStore) {
            var key = replaceToken(translationTable.redis.key, value);
            logger.log('silly', 'getting item from redis', {key: key});
            if (translationTable.redis.method == 'get') {
              getItemFromRedis(key
                , function (err, item) {
                  if (err) {
                    logger.log('warn', 'failed to get item from redis', {key: key});
                    waterfallCallback(null, 'MISS');
                  } else {
                    logger.log('silly', 'got item from redis', {key: key});
                    waterfallCallback(null, item);
                  }
                }
              );
            } else {
              getItemListFromRedis(key
                , function (err, item) {
                  if (err || !item || item.length == 0) {
                    logger.log('warn', 'failed to get item list from redis', {key: key});
                    waterfallCallback(null, 'MISS');
                  } else {
                    logger.log('silly', 'got item list from redis', {key: key});
                    waterfallCallback(null, item);
                  }
                }
              );
            }
          } else {
            waterfallCallback(null, 'MISS');
          }
        },
        function(redisResponse, waterfallCallback) {
          if (redisResponse != 'MISS')
          {
            waterfallCallback(null, redisResponse);
          } else {
            if (!translationTable.ubersmith) {
              logger.log('error', 'failed to get item from ubersmith', {translationTable: JSON.stringify(translationTable)})
              waterfallCallback({code: 500, message: 'failed to get item from ubersmith'}, 'MISS');
            } else {
              method = translationTable.ubersmith.method;
              params = replaceToken(translationTable.ubersmith.params, value);
              event = translationTable.ubersmith.key;
              logger.log('silly', 'getting item from ubersmith', {method: method, params: params, event: event});
              getItemFromUbersmith(method, params, event
                , function (err, reply) {
                  if (err) {
                    logger.log('error', 'failed to get item from ubersmith', {err: err.message, method: method, params: params, event: event})
                    waterfallCallback(err, 'MISS');
                  } else {
                    logger.log('silly', 'retrieved item from ubersmith', {method: method, params: params, event: event})
                    waterfallCallback(reply, reply);
                  }
                });
            }
          }
        }
      ], function(error, item) {
        if (item && item != 'MISS') {
          getItemKeyCallback(null, item);
        } else {
          getItemKeyCallback({code: error.code, message: 'Could not get Item ' + error.message}, null);
        }
      });
    } else {
      logger.log('error','unknown token:' + token, {family: family, token: token, value: value});
      getItemKeyCallback({code: 500, message: 'unknown token:' + token}, null);
    }
  };

  var authenticateUser = function(user, pass, authenticateCallback) {
    getItemFromUbersmith('uber.check_login', '&login=' +  encodeURI(user) + '&pass=' + encodeURI(pass), 'uber.check_login', authenticateCallback);
  }

  var getDeviceByID = function(deviceID, getDeviceIDCallback)
  {
    logger.log('debug', 'Getting Device by ID', {deviceID: deviceID});
    getCachedItem('devices', 'deviceID', deviceID, function (err, reply) {
      getDeviceIDCallback(err, reply);
    });
  };

  var getDeviceByHostname = function(hostname, getDeviceHostnameCallback)
  {
    logger.log('verbose', 'Fetch host by hostname: ' + hostname, {});
    logger.log('warn', 'This is a VERY expensive call, use deviceID whenever possible!', {hostname: hostname, function: 'getDeviceByHostname'});

    getCachedItem('devices', 'hostname', hostname, function (err, reply) {
      if (err || reply == 'MISS') {
        logger.log('error', 'Failed to get device from cache', {error: err.message});
        findDeviceIDForHostname(hostname, function(err, deviceID) {
          logger.log('debug', 'located deviceID from list', {deviceID: deviceID, dev_desc: hostname.replace(mgmtDomain, '')});
          getDeviceByID(deviceID, getDeviceHostnameCallback);
        });
      } else {
        logger.log('verbose', 'got item by hostname', {});
        getDeviceHostnameCallback(err, reply);
      }
    });
  };

  var findDeviceIDForHostname = function(hostname, findDeviceIDCallback) {
    var shortHostname = hostname.replace(mgmtDomain, '');
    getCachedItem('devices', 'list', '', function (err, deviceList) {
      if (err) {
        logger.log('error', 'Failed to get device list', {error: err.message});
        findDeviceIDCallback(err, null);
      } else {
        logger.log('debug', 'Looking up dev_desc', {shortHostname: shortHostname, mgmtDomain: mgmtDomain});
        _.each(deviceList, function(device) {
          if (device.dev_desc == shortHostname) {
            // we dont return device here, the device in the list is not the same as getDeviceByID
            return findDeviceIDCallback(null, device.dev);
          }
        });
      }
    });
  }

  var getTicketsbyDeviceID = function(deviceID, callback)
  {
    getCachedItem('tickets', 'deviceID', deviceID, function (err, reply) {
      callback(err, reply);
    });
  };

  var getDevicesbyTypeGroupID = function(typeGroupID, callback)
  {
    getCachedItem('devices', 'type_group', typeGroupID, function (err, reply) {
      callback(err, reply);
    });
  }

  var getDevicesByRack = function(rack, callback)
  {
    logger.log('verbose', 'Fetch devices by rack', {rack: rack});
    getCachedItem('devices', 'rack', hostname, function (err, reply) {
      callback(err, reply);
    });
  };

  var getDeviceTypeList = function(callback)
  {
    logger.log('verbose', 'Fetch device type list', {});
    getCachedItem('device_types', 'list', '', callback);
  };

  var getDevicesbyClientID = function(clientID, callback)
  {
    getCachedItem('devices', 'clientID', clientID, function (err, reply) {
      callback(err, reply);
    });
  }

  var getTicketsbyClientID = function(clientID, callback)
  {
    getCachedItem('tickets', 'clientID', clientID, function (err, reply) {
      callback(err, reply);
    });
  };

  var getTickets = function(callback)
  {
    getCachedItem('tickets', 'list','', callback);
  };

  var getTicketPostsbyTicketID = function(ticketID, callback)
  {
    getCachedItem('ticket_posts','ticketID', ticketID, callback);
  };

  var getTicketbyTicketID = function(ticketID, callback)
  {
    getCachedItem('tickets', 'ticketID', ticketID, callback);
  };

  var getClientByID = function(clientID, callback)
  {
    getCachedItem('clients', 'clientID', clientID, callback);
  };

  var getContactsbyClientID = function(clientID, callback)
  {
    getCachedItem('contacts', 'clientID', clientID, callback);
  };

  var getContactbyContactID = function(contactID, callback)
  {
    getCachedItem('contacts', 'contactID', contactID, callback);
  };

  var getAdmins = function(getCallback)
  {
    getCachedItem('admins', 'list', '', getCallback);
  }

  var getAllFiles = function(getCallback)
  {
    getCachedItem('clients', 'allfiles', '', getCallback);
  }

  var getClientFiles = function(clientID, getCallback)
  {
    getCachedItem('clients', 'files', clientID, getCallback);
  }

  var getAdminByEmail = function(adminEmail, getCallback) {
    getCachedItem('admins', 'list', '', function(err, adminList) {
      if (err) {
        getCallback(err);
      } else {
        var retList = [];
        var adminList = _.values(adminList);
        _.each(adminList, function(admin) {
          if (admin.email == adminEmail) {
            retList.push(admin);
          }
        });
        getCallback(null, retList);
      }
    });
  };

  var getAPIMethods = function(getCallback)
  {
    getCachedItem('admins', 'methods', '', getCallback);
  }

  var getDeviceHostnames = function(callback)
  {
    getCachedItem('devices', 'list', '', function (err, deviceList) {
      var deviceHostnames = {};
      _.each(deviceList, function(device) {
        if (device && device.dev_desc && device.dev_desc != '' && device.dev && device.dev != 0)
        {
          _.defaults(device, {first: '', last: '', email: '', company: '', email: '', clientid: '', location: '', metadata: { runbook_instructions_device: '' }});
          deviceHostnames[device.dev_desc + mgmtDomain] = {dev_desc: device.dev_desc + mgmtDomain, dev: device.dev, full_name: device.first + ' ' + device.last, email: device.email, company: device.company, clientid: device.clientid, location: device.location, runbook: device.metadata.runbook_instructions_device };
        }
      });
      callback(err, deviceHostnames);
    });
  };

  var getClientComments = function(clientid, getCallback)
  {
    getCachedItem('clients', 'comments', clientid, function (err, comments) {
      if (err) {
        getCallback(err);
      } else {
        var _ = require('underscore');
        getCallback(null, _.values(comments));
      }
    });
  }

  var getAttachments = function(getCallback)
  {
    getCachedItem('clients', 'attachments', '', getCallback);
  }

  var getAttachment = function(attachID, getCallback)
  {
    getCachedItem('comments', 'attachment', attachID, getCallback);
  }

  var getCommentAttachments = function(commentID, getCallback)
  {
    if (commentID !== null) {
      getCachedItem('comments', 'attachments', commentID, getCallback);
    } else {
      getCallback(null, []);
    }

  }

  var getAllClients = function (getClientCallback)
  {
    getCachedItem('clients', 'listAll', '', function(err, clientList) {
      getAdmins(function(err, adminList){
        var retClientList = {};
        _.each(clientList, function(client) {
          if (client.salesperson != '0')
          {
            client.salesperson_name = adminList[client.salesperson].name;
            client.salesperson_email = adminList[client.salesperson].email;
          } else {
            client.salesperson_name = '';
            client.salesperson_email = '';
          }
          retClientList[client.clientid] = client;
        });
        getClientCallback(err, retClientList);
      });
    });
  };

  var getClients = function (getClientCallback)
  {
    getCachedItem('clients', 'list', '', function(err, clientList) {
      getAdmins(function(err, adminList){
        var retClientList = {};
        _.each(clientList, function(client) {
          if (client.salesperson != '0')
          {
            client.salesperson_name = adminList[client.salesperson].name;
            client.salesperson_email = adminList[client.salesperson].email;
          } else {
            client.salesperson_name = '';
            client.salesperson_email = '';
          }
          retClientList[client.clientid] = client;
        });
        getClientCallback(err, retClientList);
      });
    });
  };

  var getEventList = function (getEventListCallback)
  {
    getCachedItem('events', 'list', '', getEventListCallback);
  };


  var getLeads = function (getLeadCallback)
  {
    getCachedItem('leads', 'list', '', function(err, leadList) {
      getAdmins(function(err, adminList){
        var retLeadList = {};
        _.each(leadList, function(lead) {
          if (lead.salesperson != '0')
          {
            lead.salesperson_name = adminList[lead.salesperson].name;
            lead.salesperson_email = adminList[lead.salesperson].email;
          } else {
            lead.salesperson_name = '';
            lead.salesperson_email = '';
          }
          retLeadList[lead.clientid] = lead;
        });
        getLeadCallback(err, retLeadList);
      });
    });
  };

  var getQuickStats = function(timestamp, getCallback)
  {
    getCachedItem('uber', 'quick_stats', timestamp, getCallback);
  }

  var getSalesPipeline = function(withStats, getPipelineCallback) {
    var stats = {};
    var flatStats = [];
    var async = require('async');
    var status_list = {};
    var stage_list = {};
    var type_list = {};

    var cleanOpportunity = function(opportunityList, stageCallback) {
      async.map(_.values(opportunityList), function(opportunityList, callback) {
        callback(null, opportunityList.data);
      }, stageCallback);
    }

    var getOpportunityStage = function(stage_id, type_id, stageCallback) {
      getCachedItem('sales', 'opportunity_list', '&opportunity_type_id=' + type_id + '&opportunity_stage_id=' + stage_id, function(err, pipelineStageResults) {
        if (err) {
          stageCallback(err);
        } else {
          cleanOpportunity(pipelineStageResults, stageCallback);
        }
      });
    };

    var concatPipelineStages = function(pipelineStages, typeCallback) {
      async.concat(pipelineStages, function(pipelineStageFull, stageConcatCallback) {
        stageConcatCallback(null, pipelineStageFull);
      }, function (err, pipelineStagesCombined) {
        typeCallback(err, pipelineStagesCombined);
      })
    };

    var concatPipelineTypes = function(pipelineTypes, flatCallback) {
      async.concat(pipelineTypes, function(pipelineType, typeConcatCallback) {
        typeConcatCallback(null, pipelineType);
      }, function (err, flattenedPipeline) {
        flatCallback(err, flattenedPipeline);
      });
    };

    var handleCombinedStages = function (pipelineStagesCombined, handleStagesCallback) {
      concatPipelineTypes(pipelineStagesCombined, handleStagesCallback);
    };

    var processOpportunityStats = function (opportunity) {
      if (opportunity.hasOwnProperty('opportunity_type_id'))
      {
        if (!stats.hasOwnProperty(opportunity.opportunity_type_id)) {
          stats[opportunity.opportunity_type_id] = {};
        }
        if (!stats[opportunity.opportunity_type_id].hasOwnProperty('values')) {
          stats[opportunity.opportunity_type_id]['values'] = [];
        }
        if (opportunity.hasOwnProperty('opportunity_stage_id')) {
          if (!stats[opportunity.opportunity_type_id].hasOwnProperty(opportunity.opportunity_stage_id)) {
            stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id] = {};
          }
          if (!stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id].hasOwnProperty('values')) {
            stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id]['values'] = [];
          }

          if (!stats.hasOwnProperty('stages')) {
            stats.stages = {};
          }

          if (!stats['stages'].hasOwnProperty([opportunity.opportunity_stage_id])) {
            stats['stages'][opportunity.opportunity_stage_id] = {};
          }

          if (opportunity.hasOwnProperty('status')) {
            if (!stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id].hasOwnProperty(opportunity.status)) {
              stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id][opportunity.status] = {};
            }

            if (!stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id][opportunity.status].hasOwnProperty('values')) {
              stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id][opportunity.status]['values'] = [];
            }

            if (!stats['stages'][opportunity.opportunity_stage_id].hasOwnProperty(opportunity.status)) {
              stats['stages'][opportunity.opportunity_stage_id][opportunity.status] = {};
            }

            if (!stats['stages'][opportunity.opportunity_stage_id][opportunity.status].hasOwnProperty('values')) {
              stats['stages'][opportunity.opportunity_stage_id][opportunity.status]['values'] = [];
            }

            stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id][opportunity.status]['values'].push(opportunity.value);
            stats[opportunity.opportunity_type_id][opportunity.opportunity_stage_id]['values'].push(opportunity.value);
            stats['stages'][opportunity.opportunity_stage_id][opportunity.status]['values'].push(opportunity.value);
            stats[opportunity.opportunity_type_id]['values'].push(opportunity.value);
          }
        }
      }
    };

    var createStatsObject = function(values) {
      var fastStatsObj = require('fast-stats').Stats;
      var typeStats = new fastStatsObj().push(values);
      var statsObject = {};
      statsObject['values'] = values;
      statsObject['sum'] = _.reduce(values, function(memo, num){ return memo + parseInt(num); }, 0);
      statsObject['average'] = typeStats.amean();
      statsObject['median'] = typeStats.median();
      statsObject['95th'] = typeStats.percentile(95);
      statsObject['range'] = typeStats.range();
      statsObject['stddev'] = typeStats.stddev();
      return statsObject;
    };

    var populateStatusStats = function(typeID, stageID, statusID, status) {
      stats[typeID][stageID][statusID]['stats'] = createStatsObject(status.values);
      stats[typeID][stageID][statusID]['type'] =type_list[typeID];
      stats[typeID][stageID][statusID]['stage'] = stage_list[stageID];
      stats[typeID][stageID][statusID]['status'] = status_list[statusID];
      flatStats.push(stats[typeID][stageID][statusID]);
      delete stats[typeID][stageID][statusID]['values'];
    }

    var populateStageStats = function(typeID, stageID, stage) {
      //stats[typeID][stageID]['stats'] = createStatsObject(stage.values);
      delete stats[typeID][stageID]['values'];
      _.each(stage, function(status, statusID) {
        populateStatusStats(typeID, stageID, statusID, status);
      })
    };

    var populateTypeStats = function (type, typeID) {
      //stats[typeID]['stats'] = createStatsObject(type.values);
      delete stats[typeID]['values'];
      _.each(type, function(stage, stageID) {
        populateStageStats(typeID, stageID, stage);
      });
    };

    var populateDetailedStatistics = function() {
      _.each(stats, populateTypeStats);
    };

    var processPipelineStats = function(collapsedPipeline) {
      // we don't care about the return value
      _.map(collapsedPipeline, processOpportunityStats);
      populateDetailedStatistics();
    };

    var processOpportunityMetadata = function (err, metadata) {
      if (err) {
        getPipelineCallback(err);
      } else {
        status_list = metadata.status_list;
        stage_list = metadata.stage_list;
        type_list = metadata.type_list;

        async.mapLimit(_.keys(type_list), 3, function(type_id, typeCallback) {
          async.mapLimit(_.keys(stage_list), 3, function(stage_id, stageCallback) {
            getOpportunityStage(stage_id, type_id, stageCallback);
          }, function(err, pipelineStages) {
            if (err) {
              typeCallback(err);
            } else {
              concatPipelineStages(pipelineStages, typeCallback);
            }
          })
        }, function (err, pipelineStagesCombined) {
          if (err) {
            getPipelineCallback(err);
          } else {
            handleCombinedStages( pipelineStagesCombined, function (err, collapsedPipeline) {
              if (err) {
                getPipelineCallback(err);
              } else {
                processPipelineStats(collapsedPipeline);
                if (withStats === true) {
                  getPipelineCallback(null, {metadata: metadata, summarizedStats: flatStats, stats: stats, pipeline: collapsedPipeline});
                } else {
                  getPipelineCallback(null, {metadata: metadata, pipeline: collapsedPipeline});
                }
              }
            })
          }
        })
      }
    };

    async.parallel({
      status_list: function(callback) {
        getCachedItem('sales', 'opportunity_status_list', '', callback);
      },
      stage_list: function(callback) {
        getCachedItem('sales', 'opportunity_stage_list', '', callback);
      },
      type_list: function(callback) {
        getCachedItem('sales', 'opportunity_type_list', '', callback);
      }
    }, processOpportunityMetadata);
  };

// Start calls removeExistingData which emits the "removed.*" events
// The exception is that the tickets are done after the devices in _handleDevicelist

  Emitter.on('removed.client.list', getCachedItem);
  Emitter.on('removed.device.list', getCachedItem);
  Emitter.on('removed.ticket.list', getCachedItem);
  //Emitter.on('removed.client.list', _retrieveKey);
  //Emitter.on('removed.device.list', _retrieveKey);
  //Emitter.on('removed.ticket.list', getCachedItem);

  //Emitter.on('removed.facility.list', _retrieveKey);
  //Emitter.on('removed.single.device', _retrieveKey);

// _handleClient pulls a list of contacts for each client
// the "client.ready_for_contacts" event is emitted there
  //Emitter.on('client.ready_for_contacts', _retrieveKey);

// Retrieve Key hits the Ubersmith API and then
// emits "ready.*.list" indicating the data from the key is ready

  Emitter.on('ready.client.list', _handleClientList);
  Emitter.on('ready.device.list', _handleDeviceList);
  Emitter.on('ready.device.group_list', _handleDeviceGroupList);
  Emitter.on('ready.ticket.list', _handleTicketList);
  Emitter.on('ready.facility.list', _handleFacilityList);
  Emitter.on('ready.single.device', _handleSingleDevice);
  Emitter.on('ready.client.tickets', _handleClientTickets);
  Emitter.on('read.type.list', _handleTypeList);

// As the list is processed, for each item in the list a "new.*" event
// is emitted to the item handlers

  Emitter.on('new.ticket', _handleTicket);
  Emitter.on('new.facility', _handleFacility);
  Emitter.on('new.contact', _handleContact);

  Emitter.on('configure.complete', function(params) {
    if (params.warm_cache === true)
    {
      start(params);
    }
  });

  Emitter.on('device.list.complete', function (deviceList) {
    logger.log('debug', 'Ubersmith Device List Loaded', {});
  });

  module.getDeviceByID = getDeviceByID;
  module.getEventList = getEventList;
  module.getDeviceByHostname = getDeviceByHostname;
  module.getTicketsbyDeviceID = getTicketsbyDeviceID;
  module.getDevicesbyTypeGroupID = getDevicesbyTypeGroupID;
  module.getDevicesByRack = getDevicesByRack;
  module.getDeviceTypeList = getDeviceTypeList;
  module.getDevicesbyClientID = getDevicesbyClientID;
  module.getTicketsbyClientID = getTicketsbyClientID;
  module.getTickets = getTickets;
  module.getTicketPostsbyTicketID = getTicketPostsbyTicketID;
  module.getTicketbyTicketID = getTicketbyTicketID;
  module.getClientByID = getClientByID;
  module.getClients = getClients;
  module.getClientComments = getClientComments;
  module.getLeads = getLeads;
  module.getAttachments = getAttachments;
  module.getAttachment = getAttachment;
  module.getCommentAttachments = getCommentAttachments;
  module.getSalesPipeline = getSalesPipeline;
  module.getClientFiles = getClientFiles;
  module.getAllFiles = getAllFiles;
  module.getDeviceHostnames = getDeviceHostnames;
  module.getContactsbyClientID = getContactsbyClientID;
  module.getContactbyContactID = getContactbyContactID;
  module.getAdmins = getAdmins;
  module.getAPIMethods = getAPIMethods;
  module.postItemToUbersmith = postItemToUbersmith;
  module.authenticateUser = authenticateUser;
  module.addPostToTicket = addPostToTicket;
  module.createNewTicket = createNewTicket;
  module.submitNewLead = submitNewLead;
  module.submitComment = submitComment;
  module.getAdminByEmail = getAdminByEmail;
  module.getQuickStats = getQuickStats;

  initialize(function(err, reply) {
    logger.log('info', 'Ubersmith Module Initialization Complete', {});
  });
  return module;
}


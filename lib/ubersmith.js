var redis = require('redis');
var cache_manager = require('cache-manager');
var redis_store = require('./redis_store');
var cache_redis = {};
var cache_multi = {};
var cache_memory = cache_manager.caching({store: 'memory', max: 2048 /*Bytes*/, ttl: 30 /*seconds*/});
var cache_primary = cache_memory;
var disableRedisStore = false;

var events = require('events');
var util = require('util');
var ctxlog = require('contegix-logger');
var logger;
var _ = require('underscore');

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
      params['cacheTTL'] = 90;
    }

    if (!params.redisDb)
    {
      params['redisDb'] = 1;
    }

    cache_redis = cache_manager.caching({store: redis_store, ttl: params['cacheTTL'] /*seconds*/, host: params['redisHost'], db:  params['redisDb'], port: params['redisPort']});
    cache_multi = cache_manager.multi_caching([cache_memory, cache_redis]);
    cache_primary = cache_multi;

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

    saveValue(key, value, true, 90, function (err, res) {
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
    if (disableRedisStore == true)
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
    logger.log('silly', 'Expiration Callback', {callback: expirationCallback});
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
      expiration = 90; /* Seconds */
    }

    if (arguments.length <= 4)
    {
      callback = function() { return; };
    }

    if (disableRedisStore)
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
    if (disableRedisStore)
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
      saveValue('devices:hostname:' + hostname + '.contegix.mgmt', JSONDevice, false);
    }
  };

  var _handleDevice = function(device, callback)
  {
      var deviceID = device.dev;
      var deviceHostname = device.dev_desc || '';
      var async = require('async');

      logger.log('debug', 'handling device ' + deviceID + ' completed', {deviceID: deviceID, hostname: device.dev_desc + '.contegix.mgmt'})

      if (deviceHostname != '')
      {
        redisClient.del('devices:hostname:' + device.dev_desc, function (err, reply) {
          saveValue('devices:hostname:' + deviceHostname, device, true, -1, function (err, reply) {
            if (err)
            {
              logger.log('error', err, {err: err, deviceID: deviceID, hostname: device.dev_desc + '.contegix.mgmt'});
            }
          });
        });
      }

      redisClient.del('devices:deviceID:' + deviceID, function (err, reply) {
        saveValue('devices:deviceID:' + deviceID, device, true, -1, function(err, reply) {
          if (err)
          {
            logger.log('error', err, {err: err, deviceID: deviceID, hostname: device.dev_desc + '.contegix.mgmt'});
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

    logger.log('debug', 'handling device sets', {deviceID: device.dev, hostname: device.dev_desc + '.contegix.mgmt'});

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
    ubersmith: { method: 'device.get', params: '&client_id=%token%&modules=1&require_ip=1&metadata=1', key: 'client.devices'}
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
  UberettaStone['clients'] = {};
  UberettaStone['clients']['clientID'] = {
    redis: { key: 'clients:%token%', method: 'get'},
    ubersmith: { method: 'client.get', params: '&client_id=%token%&metadata=1&tags=1', key: 'single.client'}
  }

  UberettaStone['clients']['list'] = {
    redis: { key: 'clients', method: 'smembers'},
    ubersmith: { method: 'client.list', params: '&short=0&inactive=0&active=1&billing_info=1', key: 'client.list'}
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

  UberettaStone['device_types'] = {};
  UberettaStone['device_types']['list'] = {
    redis: { key: 'device_types:list', method: 'get'},
    ubersmith: { method: 'device.type_list', params: '',  key: 'type.list'}
  };

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
      var async = require('async');
      async.mapLimit(keys, 20, getValue, getItemListCallback);
    });
  };

  var getItemFromRedis = function(key, getItemFromRedisCallback)
  {
    if (key == '')
    {
      getItemFromRedisCallback(new Error('invalid key'), null);
    } else if (disableRedisStore) {
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
        'Host': 'portal.contegix.com',
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
      callback(error, body);
    });
  };

  var ubersmithRequest = function(uberOptions, ubersmithRequestCallback) {
    cache_memory.wrap(uberOptions.url, function(cacheCallback) {
      var request = require('request');
      request(uberOptions, cacheCallback);
    }, ubersmithRequestCallback);
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
      , function (err, res)
      {
        if (err)
        {
          logger.log('error', 'request failed with err: ' + err.message, {err: err, url: uberOptions['url'], event:'failed.' + key });
          Emitter.emit('failed.' + key, err);
          getUSItemCallback(err, null);
        }
        else
        {
          var event = 'ready.' + key;
          logger.log('debug', 'request complete', {url: uberOptions['url'], event:event });
          if (res.body.data)
          {
            logger.log('debug', 'success ' + event, {event: event, url:  uberOptions['url']});
            Emitter.emit(event, res.body.data);
            getUSItemCallback(null, res.body.data);
          } else {
            logger.log('warn', 'failed: ' + key, {key: key, url:  uberOptions['url']});
            logger.log('verbose', 'failed data', {body: JSON.stringify(res.body)});
            Emitter.emit('failed.' + key, new Error('failed to find data in res.body'));
          }
        }
      }
    );
  };

  var getCachedItem = function(family, token, value, getCachedItemCallback) {
    var key = JSON.stringify({family: family, token: token, value: value});
    logger.log('debug', 'Attempting to get Cached Item', {item: key});
    cache_primary.wrap(key, function(cacheCallback) {
      getItemKey(key, cacheCallback);
    }, getCachedItemCallback);
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
                if (err) {
                  logger.log('warn', 'failed to get item list from redis', {key: key});
                  waterfallCallback(null, 'MISS');
                } else {
                  logger.log('silly', 'got item list from redis', {key: key});
                  waterfallCallback(null, item);
                }
              }
            );
          }
        },
        function(redisResponse, waterfallCallback) {
          if (redisResponse != 'MISS')
          {
            waterfallCallback(null, redisResponse);
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
      ], function(error, item) {
        if (item) {
          getItemKeyCallback(null, item);
        } else {
          getItemKeyCallback(new Error('Could not locate Item'), null);
        }
      });
    } else {
      logger.log('error','unknown token:' + token, {family: family, token: token, value: value});
      getItemKeyCallback(new Error('unknown token:' + token), null);
    }
  };

  var getDeviceByID = function(deviceID, callback)
  {
    getCachedItem('devices', 'deviceID', deviceID, function (err, reply) {
      callback(err, reply);
    });
  };

  var getDeviceByHostname = function(hostname, callback)
  {
    logger.log('verbose', 'Fetch host by hostname: ' + hostname, {});
    getCachedItem('devices', 'hostname', hostname, function (err, reply) {
      callback(err, reply);
    });
  };

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

  var getDeviceHostnames = function(callback)
  {
    getCachedItem('devices', 'list', '', function (err, deviceList) {
      var deviceHostnames = {};
      _.each(deviceList, function(device) {
        if (device && device.dev_desc && device.dev_desc != '' && device.dev && device.dev != 0)
        {
          _.defaults(device, {first: '', last: '', email: '', company: '', email: '', clientid: '', location: '', metadata: { runbook_instructions_device: '' }});
          deviceHostnames[device.dev_desc + '.contegix.mgmt'] = {dev_desc: device.dev_desc + '.contegix.mgmt', dev: device.dev, full_name: device.first + ' ' + device.last, email: device.email, company: device.company, clientid: device.clientid, location: device.location, runbook: device.metadata.runbook_instructions_device };
        }
      });
      callback(err, deviceHostnames);
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

// Start calls removeExistingData which emits the "removed.*" events
// The exception is that the tickets are done after the devices in _handleDevicelist

  Emitter.on('removed.client.list', getCachedItem);
  Emitter.on('removed.device.list', getCachedItem);
  Emitter.on('removed.ticket.list', getCachedItem);
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
  module.getDeviceHostnames = getDeviceHostnames;
  module.getContactsbyClientID = getContactsbyClientID;
  module.getContactbyContactID = getContactbyContactID;
  module.getAdmins = getAdmins;
  module.postItemToUbersmith = postItemToUbersmith;

  initialize(function(err, reply) {
    logger.log('info', 'Ubersmith Module Initialization Complete', {});
  });
  return module;
}


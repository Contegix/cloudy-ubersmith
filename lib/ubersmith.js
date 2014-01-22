var redis = require('redis');
var events = require('events');
var util = require('util');
var ctxlog = require('contegix-logger');
var _ = require('underscore');

var logger = ctxlog('uberdata', 'debug');
var redisClient = {};
var uberAuth = new Array();

var populateUberData = function(params)
{
  this.on('newListener', function(event, listener) {
    logger.log('debug', 'new listener for ' + event, {event: event});
  });

  this.on('removeListener', function(event, listener) {
    logger.log('debug', 'removed listener for ' + event, {event: event});
  });

  this.configure = function(params)
  {
    var _ = require('underscore');

    if (!params)
    {
      raiseError('params required');
    }

    if(!_.has(params, 'uberAuth'))
    {
      raiseError('uberAuth is a required parameter');
      return;
    }

    uberAuth = params['uberAuth'];

    if (!(_.has(uberAuth, 'username')))
    {
      raiseError('uberAuth.username is a required parameter');
      return;
    }

    if (!_.has(uberAuth, 'password'))
    {
      raiseError('uberAuth.password is a required parameter');
      return;
    }

    if (!_.has(uberAuth, 'url'))
    {
      raiseError('uberAuth.url is a required parameter');
      return;
    }

    if(!_.has(params, 'redisHost'))
    {
      raiseError('redisHost is a required parameter');
      return;
    }

    if(!_.has(params, 'redisPort'))
    {
      raiseError('redisPort is a required parameter');
      return;
    }
    redisClient = redis.createClient(params['redisPort'], params['redisHost']);
    redisClient.on('error', function (error) {
      logger.log('error', 'Redis Connect Error', { error: error });
    });

    redisClient.on("connect"
      , function () {
        var redisTestUUID = require('uuid').v4();
        redisClient.set('test_' + redisTestUUID, redisTestUUID);
        redisClient.get('test_' + redisTestUUID
          , function (error, response) {
            if (error)
            {
              logger.log('error', 'Error retrieving value from Redis during startup test', error);
            } else {
              if (response != redisTestUUID)
              {
                logger.log('error', 'Redis returned the incorrect value for redisTestUUID', { redisTestUUID: redisTestUUID, response: response });
              } else {
                module.exports.emit('configure.complete');
                module.exports.done = true
              }
            }
          });
      });
  }
  this.start = function(params)
  {
    if (!module.exports.done)
    {
      throw new Error('Start called before configure completed, aborting');
    }
    logger.log('debug', 'started', {params: params});
    removeExistingData ('devices:*', { 'finish_event': 'removed.device.list', method: 'device.list', method_params: '', key: 'device.list'});
    removeExistingData ('client:*', { 'finish_event': 'removed.client.list', method: 'client.list', method_params: '', key: 'client.list'});
    removeExistingData ('locations:*', { 'finish_event': 'removed.facility.list', method: 'device.facility_list', method_params: '', key: 'facility.list'});
  };

  var removeExistingData = function(keys, params)
  {
    redisClient.keys(keys, function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing data: ' + keys);
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          var key = reply[i];
          //logger.log('debug', 'removing key: ' + key);

          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              traiseError('Could not remove existing data: ' + keys);
            } else {

            }
          });
        }
        module.exports.emit(params['finish_event'], params['method'], params['method_params'], params['key']);
      }
    });
  };
  var raiseError = function(message)
  {
    logger.log('error', 'raise error: ' + message, {});
    throw Error(message);
  };

  var saveValue = function(key, value, serialize)
  {
    if (arguments.length == 2) {
      serialize = true;
    }

    if (serialize == true)
    {
      value = JSON.stringify(value);
    }

    if (!value || value == '')
    {
      logger.log('debug', 'Attempted to store empty value for key: ' + key, {key: key});
      return;
    }

    redisClient.set(key
      , value
      , function (err, res) {
        if (err) {
          logger.log('error', 'Failed to save value for key: ' + key, {key: key, err: err, res: res});
        } else {
          //logger.log('debug', 'Saved value for key: ' + key, {key: key, res: res});

        }
      });
  };

  var addValuetoSet = function(key, value, serialize)
  {
    if (arguments.length == 2) {
      serialize = true;
    }

    if (serialize == true)
    {
      value = JSON.stringify(value);
    }

    redisClient.sadd(key
      , value
      , function (err, res) {
        if (err) {
          logger.log('error', 'Failed to save value for set: ' + key, {key: key, err: err, res: res});
        } else {
          //logger.log('debug', 'Saved value for set: ' + key, {key: key, res: res});
        }
      });
  };

  var _handleClient = function(client)
  {
    var clientID = client.clientid;
    if (client.company != 'REMOVED' && client.active == 1)
    {
      saveValue('client:' + clientID, client);
      module.exports.emit('client.ready_for_contacts', 'client.contact_list', '&client_id=' + clientID + '&metadata=1&contact_active=1', 'contact.list');

    }
    else
    {
      redisClient.del('client:' + clientID);
      redisClient.del('client:' + clientID + ':devices');
      redisClient.del('client:' + clientID + ':contacts');
      redisClient.del('client:' + clientID + ':tickets');
    }
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

  var _handleDevice = function(device)
  {
    var JSONDevice = JSON.stringify(device);
    var deviceID = device.dev;

    addValuetoSet('devices:list', JSONDevice, false);

    // Populate Device Detail
    //saveValue('devices:' + deviceID, JSONDevice, false);
    removeExistingData('devices:' + deviceID, {finish_event:'removed.single.device', method:'device.get', method_params:'&device_id=' + deviceID + '&modules=1&metadata=1', key:'single.device'})

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
      addValuetoSet('client:' + device.clientid + ':devices', JSONDevice, false);
    }
  };

  var _handleContact = function(contact)
  {
    addValuetoSet('client:' + contact.client_id + ':contacts', JSON.stringify(contact), false);
    saveValue('contacts:' + contact.contact_id, JSON.stringify(contact), false);
  };

  var _handleTicket = function(ticket)
  {
    redisClient.get('devices:deviceid:' + ticket.device_id, function (err, reply)
    {
      if (reply)
      {
        var device = JSON.parse(reply);
        ticket.dev_desc = device.dev_desc;
      }
      var JSONTicket = JSON.stringify(ticket);
      addValuetoSet('client:' + ticket.client_id + ':tickets', JSONTicket, false);
      addValuetoSet('devices:' + ticket.device_id + ':tickets', JSONTicket, false);
      saveValue('tickets:' + ticketID, JSONTicket, false);
    });
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
    logger.log('debug', 'ready.client.list', {});
    _.each(clientList, function(client) {
      module.exports.emit('new.client', client);
    });
  };

  var _handleDeviceList = function(deviceList)
  {
    logger.log('debug', 'ready.device.list', {});
    _.each(deviceList, function(device) {
      module.exports.emit('new.device', device);
    });

    // Tickets are handled after the devices are populated so some information
    // from the device can be added to the ticket
    removeExistingData ('tickets:*', { 'finish_event': 'removed.ticket.list', method: 'ticket.list', method_params: '&queue=1&metadata=1&type=ClientAll', key: 'ticket.list'});
  };

  var _handleTicketList = function(ticketList) {
    logger.log('debug', 'ready.ticket.list', {});
    _.each(ticketList, function(ticket) {
      module.exports.emit('new.ticket', ticket);
    });
  };

  var _handleFacilityList = function(facilityList) {
    logger.log('debug', 'ready.facility.list', {});
    _.each(facilityList, function(facility) {
      module.exports.emit('new.facility', facility);
    });
  };

  var _handleContactList = function(contactList) {
    logger.log('debug', 'ready.contact.list', {});
    _.each(contactList, function(contact) {
      module.exports.emit('new.contact', contact);
    });
  };

  var _retrieveKey = function(method, params, key) {
    if (arguments.length < 2)
    {
      params = '';
    }

    if(arguments.length < 3)
    {
      key = method;
    }

    //logger.log('debug', 'retrieve key: ' + key, { method: method, params: params, key: key});
    var request = require('request');
    var uberOptions = {
      'url':uberAuth['url'] + '/?method=' + method + params,
      'auth': { 'user': uberAuth['username'],
        'pass': uberAuth['password'],
        'sendImmediately': false
      },
      json: true
    };

    request(uberOptions
      , function (err, res)
      {
        if (err)
        {
          logger.log('error', 'request failed with err: ' + err.message, {err: err, url: uberOptions['url'], event:'failed.' + key });
          module.exports.emit('failed.' + key, err);
        }
        else
        {
          var event = 'ready.' + key;
          logger.log('debug', 'request complete', {url: uberOptions['url'], event:event });
          if (module.exports.listeners(event).length < 1)
          {
            logger.log('error', 'no handler for event:' + event, {event: event, url:  uberOptions['url']});
          }
          if (res.body.data)
          {
            logger.log('debug', 'success ' + event, {event: event, url:  uberOptions['url']});
            module.exports.emit(event, res.body.data);
          } else {
            logger.log('error', 'failed: ' + key, {key: key, url:  uberOptions['url']});
            module.exports.emit('failed.' + key, new Error('failed to find data in res.body'));
          }

        }
      }
    );
  };

  // Start calls removeExistingData which emits the "removed.*" events
  // The exception is that the tickets are done after the devices in _handleDevicelist

  this.on('removed.client.list', _retrieveKey);
  this.on('removed.device.list', _retrieveKey);
  this.on('removed.ticket.list', _retrieveKey);
  this.on('removed.facility.list', _retrieveKey);
  this.on('removed.single.device', _retrieveKey);

  // _handleClient pulls a list of contacts for each client
  // the "client.ready_for_contacts" event is emitted there
  this.on('client.ready_for_contacts', _retrieveKey);

  // Retrieve Key hits the Ubersmith API and then
  // emits "ready.*.list" indicating the data from the key is ready

  this.on('ready.client.list', _handleClientList);
  this.on('ready.device.list', _handleDeviceList);
  this.on('ready.ticket.list', _handleTicketList);
  this.on('ready.facility.list', _handleFacilityList);
  this.on('ready.contact.list', _handleContactList);
  this.on('ready.single.device', _handleSingleDevice);

  // As the list is processed, for each item in the list a "new.*" event
  // is emitted to the item handlers

  this.on('new.ticket', _handleTicket);
  this.on('new.device', _handleDevice);
  this.on('new.client', _handleClient);
  this.on('new.facility', _handleFacility);
  this.on('new.contact', _handleContact);
  // Methods below this point are for retrieving data from the Ubersmith Cache

  // This construct identifies the information neccessary to take a family and key and get back the object(s)
  // from Redis and Ubersmith
  var UberettaStone = {};

  UberettaStone['devices'] = {};
  UberettaStone['devices']['deviceID'] = {
    redis: { key: 'devices:%token%', method: 'get'},
    ubersmith: { method: 'device.get', params: '&device_id=%token%&modules=1&metadata=1', key: 'single.device'}
  };
  UberettaStone['devices']['hostname'] = {
    redis: { key: 'devices:hostname:%token%', method: 'get'},
    ubersmith: null
  };
  UberettaStone['devices']['rack'] = {
    redis: { key: 'devices:locations:racks:%token', method: 'smembers'},
    ubersmith: null
  };

  UberettaStone['device_types'] = {};
  UberettaStone['device_types']['list'] = {
    redis: { key: 'device_types:list', method: 'get'},
    ubersmith: { method: 'device.type_list', params: '',  key: 'type.list'}
  };

  UberettaStone['tickets'] = {};
  UberettaStone['tickets']['deviceID'] = {
    redis: { key: 'devices:%token%:tickets', method: 'smembers'},
    ubersmith: { method: 'support.ticket_list', params: '&queue=1&metadata=1&type=ClientAll&device_id=%token%',  key: 'device.tickets'}
  };

  var replaceToken = function(str, value)
  {
    return str.replace('%token%', value);
  };

  var getItemFromRedis = function(key, method, callback)
  {
    redisClient[method](key, function (err, reply){
      if (err)
      {
        logger.log('error', 'getDeviceByHostname: ' + err.message, {error: err});
        callback(err, null);
      } else {
        callback(null, JSON.parse(reply));
      }
    });
  };

  var getItemFromUbersmith = function(method, params, key, getUSItemCallback)
  {
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
          module.exports.emit('failed.' + key, err);
          getUSItemCallback(err, null);
        }
        else
        {
          getUSItemCallback(null, res.body.data);
          var event = 'ready.' + key;
          logger.log('debug', 'request complete', {url: uberOptions['url'], event:event });
          module.exports.emit(event, res.body.data);
        }
      }
    );
    getUSItemCallback(new Error('not implemented'), null);
  };

  this.getItem = function(family, token, value, getItemCallback) {
    if (UberettaStone[family] && UberettaStone[family][token]) {
      var translationTable = UberettaStone[family][token];
      getItemFromRedis(replaceToken(translationTable.redis.key, value), translationTable.redis.method
        , function (err, reply) {
          if (!reply)
          {
            if (translationTable.ubersmith != null)
            {
              getItemFromUbersmith(translationTable.ubersmith.method, replaceToken(translationTable.ubersmith.params, value), translationTable.ubersmith.key, function (err, reply) {
                if (!reply)
                {
                  logger.log('error', 'Error getting item from Ubersmith', {err: JSON.stringify(err)});
                  getItemCallback(err);
                } else {
                  getItemCallback(null, reply);
                }
              });
            } else {
              logger.log('error', 'could not retrieve item from Ubersmith by ' + token, {family: family, token: token, value: value});
              getItemCallback(new Error('could not retrieve item from Ubersmith by ' + token), null);
            }
          } else {
            logger.log('debug','redis returned value', {family: family, token: token, value: value});
            getItemCallback(err, reply);
          }
        });
    } else {
      logger.log('error','unknown token:' + token, {family: family, token: token, value: value});
      getItemCallback(new Error('unknown token:' + token), null);
    }
  };

  this.getDeviceByID = function(deviceID, callback)
  {
    this.getItem('devices', 'deviceID', deviceID, function (err, reply) {
      callback(err, reply);
    });
  };

  this.getDeviceByHostname = function(hostname, callback)
  {
    logger.log('debug', 'Fetch host by hostname: ' + hostname, {});
    this.getItem('devices', 'hostname', hostname, function (err, reply) {
      callback(err, reply);
    });
  };

  this.getTicketsbyDeviceID = function(deviceID, callback)
  {
     this.getItem('tickets', 'deviceID', deviceID, function (err, reply) {
        callback(err, reply);
     });
  };

  this.getDevicesByRack = function(rack, callback)
  {
    logger.log('debug', 'Fetch devices by rack', {rack: rack});
    this.getItem('devices', 'rack', hostname, function (err, reply) {
       callback(err, reply);
    });
  };

  this.getDeviceTypeList = function(callback)
  {
    logger.log('debug', 'Fetch device type list', {});
    this.getItem('device_types', 'list', '', callback);
  };
};

util.inherits(populateUberData, events.EventEmitter);
module.exports = new populateUberData();
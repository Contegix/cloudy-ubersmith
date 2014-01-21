var redis = require('redis');
var events = require('events');
var ctxlog = require('contegix-logger');
var logger = ctxlog('uberdata', 'error');
var util = require('util');
var redisClient = {};
var uberAuth = new Array();
var _ = require('underscore');

var populateUberData = function(params)
{
  this.on('newListener', function(event, listener) {
    logger.log('debug', 'new listener for ' + event, {event: event});
  });

  this.on('removeListener', function(event, listener) {
    logger.log('debug', 'removed listener for ' + event, {event: event});
  });

  var raiseError = function(message)
  {
    logger.log('error', 'raise error: ' + message, {});
    throw Error(message);
    return;
  }

  var saveValue = function(key, value, serialize)
  {
    if (arguments.length == 2) {
      var serialize = true;
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
          logger.log('debug', 'Saved value for key: ' + key, {key: key, res: res});

        }
      });
  }

  var addValuetoSet = function(key, value, serialize)
  {
    if (arguments.length == 2) {
      var serialize = true;
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
          logger.log('debug', 'Saved value for set: ' + key, {key: key, res: res});
        }
      });
  }

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
  }

  var _handleDevice = function(device)
  {
    var JSONDevice = JSON.stringify(device);
    var deviceID = device.dev;

    saveValue('devices:' + deviceID, JSONDevice, false);

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

    if (device.dev_desc && device.dev_desc != 'null')
    {
      saveValue('devices:hostname:' + device.dev_desc + '.contegix.mgmt', JSONDevice, false);
    }

    if (device.clientid && device.clientid != 'null')
    {
      addValuetoSet('devices:clientid:' + device.clientid, JSONDevice, false);
      addValuetoSet('client:' + device.clientid + ':devices', JSONDevice, false);
    }
  }
  var _handleContact = function(contact)
  {
    addValuetoSet('client:' + contact.client_id + ':contacts', JSON.stringify(contact), false);
    saveValue('contacts:' + contact.contact_id, JSON.stringify(contact), false);
  }

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
  }

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
  }

  var _handleClientList = function(clientList)
  {
    logger.log('debug', 'ready.client.list', {});
    _.each(clientList, function(client) {
      module.exports.emit('new.client', client);
    });
  }

  var _handleDeviceList = function(deviceList)
  {
    logger.log('debug', 'ready.device.list', {});
    _.each(deviceList, function(device) {
      module.exports.emit('new.device', device);
    });
    redisClient.keys('tickets:*', function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing tickets');
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          var key = reply[i];
          logger.log('debug', 'removing key: ' + key);
          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              raiseError('Could not remove existing tickets');
            }
          });
        }
        logger.log('debug', 'remove ticket list');
        module.exports.emit('removed.ticket.list', 'ticket.list', '&queue=1&metadata=1&type=ClientAll', 'ticket.list');
      }
    });
  }

  var _handleTicketList = function(ticketList) {
    logger.log('debug', 'ready.ticket.list', {});
    _.each(ticketList, function(ticket) {
      module.exports.emit('new.ticket', ticket);
    });
  }

  var _handleFacilityList = function(facilityList) {
    logger.log('debug', 'ready.facility.list', {});
    _.each(facilityList, function(facility) {
      module.exports.emit('new.facility', facility);
    });
  }

  var _handleContactList = function(contactList) {
    logger.log('debug', 'ready.contact.list', {});
    _.each(contactList, function(contact) {
      module.exports.emit('new.contact', contact);
    });
  };

  this.on('new.ticket', _handleTicket);
  this.on('new.device', _handleDevice);
  this.on('new.client', _handleClient);
  this.on('new.facility', _handleFacility);
  this.on('new.contact', _handleContact);

  this.on('ready.client.list', _handleClientList);
  this.on('ready.device.list', _handleDeviceList);
  this.on('ready.ticket.list', _handleTicketList);
  this.on('ready.facility.list', _handleFacilityList);
  this.on('ready.contact.list', _handleContactList);

  _retrieveKey = function(method, params, key) {
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
            logger.log('debug', 'success ' + event, {event: event, url:  uberOptions['url']})
            module.exports.emit(event, res.body.data);
          } else {
            logger.log('error', 'failed: ' + key, {key: key, url:  uberOptions['url']})
            module.exports.emit('failed.' + key, new Error('failed to find data in res.body'));
          }

        }
      }
    );
  };

  this.on('removed.client.list', _retrieveKey);
  this.on('removed.device.list', _retrieveKey);
  this.on('removed.ticket.list', _retrieveKey);
  this.on('removed.facility.list', _retrieveKey);
  this.on('client.ready_for_contacts', _retrieveKey)

  this.start = function(params)
  {
    logger.log('debug', 'started', {params: params});

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

    if (!_.has(uberAuth, 'username'))
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

    redisClient.keys('devices:*', function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing devices');
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          var key = reply[i];
          logger.log('debug', 'removing key: ' + key);

          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              traiseError('Could not remove existing devices');
            } else {

            }
          });
        }
        logger.log('debug', 'remove device list');
        module.exports.emit('removed.device.list', 'device.list', '', 'device.list');
      }
    });

    redisClient.keys('client:*', function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing clients');
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          var key = reply[i];
          logger.log('debug', 'removing key: ' + key);

          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              raiseError('Could not remove existing clients');
            }
          });
        }
        logger.log('debug', 'remove client list');
        module.exports.emit('removed.client.list', 'client.list', '', 'client.list');
      }
    });

    redisClient.keys('locations:*', function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing facilities');
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          var key = reply[i];
          logger.log('debug', 'removing key: ' + key);

          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              raiseError('Could not remove existing facilities');
            }
          });
        }
        logger.log('debug', 'removed facility list');
        module.exports.emit('removed.facility.list', 'device.facility_list', '', 'facility.list');
      }
    });
  }
}

util.inherits(populateUberData, events.EventEmitter);
module.exports = new populateUberData();
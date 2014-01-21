var redis = require('redis');
var events = require('events');
var ctxlog = require('../../ctxlog');
var logger = ctxlog('uberdata', 'info');
var util = require('util');
var redisClient;
var uberAuth;

var populateUberData = function(params)
{
  var _ = require('underscore');

  if(!_.has(params, 'uberAuth'))
  {
    raiseError('uberAuth is a required parameter');
    return;
  }

  uberAuth = params['uberAuth'];

  if (!_.has(this.uberAuth, 'username'))
  {
    raiseError('uberAuth.username is a required parameter');
    return;
  }

  if (!_.has(module.exports.uberAuth, 'password'))
  {
    raiseError('uberAuth.password is a required parameter');
    return;
  }

  if (!_.has(module.exports.uberAuth, 'url'))
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

  this.start = function()
  {
    redisClient.keys('devices:*', function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing devices');
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          logger.log('info', 'removing key: ' + key);
          var key = reply[i];
          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              traiseError('Could not remove existing devices');
            } else {
              module.exports.emit('removed.device.list');
            }
          });
        }
      }
    });

    redisClient.keys('clients:*', function (err, reply)
    {
      if (err)
      {
        raiseError('Could not remove existing clients');
      } else {
        for (i = 0; i <= reply.length; i++)
        {
          var key = reply[i];
          logger.log('info', 'removing key: ' + key);
          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              raiseError('Could not remove existing clients');
            } else {
              module.exports.emit('removed.client.list');
            }
          });
        }
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
          logger.log('info', 'removing key: ' + key);
          var key = reply[i];
          redisClient.del(key, function (err, reply)
          {
            if (err)
            {
              raiseError('Could not remove existing facilities');
            } else {
              module.exports.emit('removed.facility.list');
            }
          });
        }
      }
    });
  }

  var raiseError = function(message)
  {
    raiseError(message));
    return;
  }

  var retrieveKey = function(method, params, key) {
    var request = require('request');
    var uberOptions = {
      'url': module.exports.uberAuth['url'] + '/?method=' + method + params,
      'auth': { 'user': module.exports.uberAuth['username'],
        'pass': module.exports.uberAuth['password'],
        'sendImmediately': false
      },
      json: true
    };

    request(uberOptions
      , function (err, res)
      {
        if (err)
        {
          this.emit('failed.' + key, err);
        }
        else
        {
          this.emit('ready.' + key, res.body.data);
        }
      }
    );
  };

  this.on('removed.client.list', this.retrieveKey('client.list'));
  this.on('removed.device.list', this.retrieveKey('device.list'));
  this.on('removed.ticket.list', this.retrieveKey('ticket.list', '&queue=1&metadata=1&type=ClientAll', 'ticket.list'));
  this.on('removed.facility.list', this.retrieveKey('device.facility_list', '', 'facility.list'));

  this.on('ready.client.list', function(clientList) {
    Object.keys(clientList).forEach(function(clientID) {
      _handleClient[clientList[clientID]];
    });
  });

  this.on('ready.device.list', function(deviceList) {
    Object.keys(deviceList).forEach(function(deviceID) {
      _handleDevice[deviceList[deviceID]];
      redisClient.keys('tickets:*', function (err, reply)
      {
        if (err)
        {
          raiseError('Could not remove existing tickets');
        } else {
          for (i = 0; i <= reply.length; i++)
          {
            var key = reply[i];
            logger.log('info', 'removing key: ' + key);
            redisClient.del(key, function (err, reply)
            {
              if (err)
              {
                raiseError('Could not remove existing tickets');
              } else {
                this.emit('removed.ticket.list');
              }
            });
          }
        }
      });
    });
  });

  this.on('ready.ticket.list', function(ticketList) {
    Object.keys(ticketList).forEach(function(ticketID) {
      _handleTicket[ticketList[ticketID]];
    });
  });

  this.on('ready.facility.list', function(facilityList) {
    Object.keys(facilityList).forEach(function(facilityID) {
      _handleFacility[facilityList[facilityID]];
    });
  });

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
    if (client.company != 'REMOVED' && client.active == 1)
    {
      saveValue('client:' + clientid, client);
    }
    else
    {
      redisClient.del('client:' + clientid);
      redisClient.del('client:' + clientid + ':devices');
      redisClient.del('client:' + clientid + ':contacts');
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
    var facilityName = facility['fac_name'];
    var facilityCode = (facility['fac_code'] == '') ? facility['fac_name'] : facility['fac_code'];
    var zoneList = facilityList[facilityID].zones;

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
}

util.inherits(populateUberdata, events.EventEmitter);
module.exports = new populateUberData();
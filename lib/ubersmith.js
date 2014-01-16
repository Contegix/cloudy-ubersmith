/**
 * Ubersmith Integration
 */
var EventEmitter = require('events').EventEmitter;

var request = require('request')

module.exports = new EventEmitter();
module.exports.uberAuth = new Array();

module.exports.uberRefreshData = function(method, params, key) {
  if (arguments.length == 1) {
    var params = '';
    var key = method;
  }

  if (arguments.length == 2) {
    var key = method;
  }

  var uberOptions = { 
    'url': module.exports.uberAuth['url'] + '/?method=' + method + params,
    'auth': { 'user': module.exports.uberAuth['username'],
              'pass': module.exports.uberAuth['password'],
              'sendImmediately': false
    },
    json: true
  }

  request(uberOptions,
    function(err, res) { 
      if (err) {
        module.exports.emit('failed.' + key, err);
      } else {
        module.exports.emit('ready.' + key, res.body, key);
      }
    }
  )
}

module.exports.uberScheduleRefresh = function(method, interval, params, key)
{
  if (arguments.length == 1) {
    var params = '';
    var key = method;
  }

  if (arguments.length == 2) {
    var key = method;
  }

  setInterval(function() { module.exports.uberRefreshData(method, params, key) }, interval * 1000);
}
/**
 * End Ubersmith
 */

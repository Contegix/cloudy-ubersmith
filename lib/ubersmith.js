/**
 * Ubersmith Integration
 */
var EventEmitter = require('events').EventEmitter;

var request = require('request')

module.exports = new EventEmitter();
module.exports.uberAuth = new Array();

module.exports.uberRefreshData = function(method) {
  var uberOptions = { 
    'url': module.exports.uberAuth['url'] + '/?method=' + method,
    'auth': { 'user': module.exports.uberAuth['username'],
              'pass': module.exports.uberAuth['password'],
              'sendImmediately': false
    },
    json: true
  }

  request(uberOptions,
    function(err, res) { 
      if (err) {
        module.exports.emit('failed.' + method, err);
      } else {
        module.exports.emit('ready.' + method, res.body);
      }
    }
  )
}

module.exports.uberScheduleRefresh = function(method, interval)
{
  setInterval(function() { module.exports.uberRefreshData(method) }, interval * 60 * 1000);
}
/**
 * End Ubersmith
 */

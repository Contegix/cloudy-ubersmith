/**
 * Ubersmith Integration
 */
var EventEmitter = require('events').EventEmitter;

var request = require('request')

module.exports = new EventEmitter();

module.exports.uberRefreshData = function(method) {
  var uberOptions = { 
    'url': UberAuth['url'] + '/?method=' + method,
    'auth': { 'user': UberAuth['username'],
              'pass': UberAuth['password'],
              'sendImmediately': false
    }
  }

  request(uberOptions,
    function(err, res) { 
      if (err) {
        console.log(err);
      } else {
        module.exports.emit('ready.device.list', res.body);
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

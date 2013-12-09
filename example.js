UberAuth = new Array();
UberAuth['username'] = 'username';
UberAuth['password'] = 'password';
UberAuth['url'] = 'https://ubersmith.appliance/api/2.0';

var ubersmith = require('ubersmith');
// Set the Ubersmith Username, password and URL locations
ubersmith.uberAuth = UberAuth;

// fetch the device.list right now
ubersmith.uberRefreshData('device.list');

//fetch the device list every 1 minute
ubersmith.uberScheduleRefresh('device.list', 1);

ubersmith.on('ready.device.list',
  function(body) {
    console.log(body);
  }
);

ubersmith.on('failed.device.list',
  function(err) {
    console.log(err);
  }
);

ubersmith.uberRefreshData('client.list');
ubersmith.uberScheduleRefresh('client.list', 10);

ubersmith.on('ready.client.list',
  function(body) {
    console.log(body);
  }
);

ubersmith.on('failed.client.list',
  function(err) {
    console.log(err);
  }
);

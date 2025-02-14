const DMX = require('dmx');
const dmx = new DMX();

 const universe = dmx.addUniverse('my_dmx_universe', 'enttec-open-usb-dmx', '/dev/tty.usbserial-BG00QGXZ');
//const universe = dmx.addUniverse('my_dmx_universe', 'enttec-usb-dmx-pro', '/dev/tty.usbserial-BG00QGXZ');

setTimeout(()=>{
universe.update({ 1: 255, 2: 0, 3: 0 });
}, 2000);
setTimeout(()=>{
universe.update({ 1: 0, 2: 255, 3: 0 });
}, 4000);
setTimeout(()=>{
universe.update({ 1: 0, 2: 0, 3: 255 });
}, 6000);


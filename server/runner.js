const vm = require('vm');
const fs = require('fs');
const dgram = require('dgram');
const bulb = require('./bulb.js');
const Bulb = bulb.Bulb;

let runId = 0;

// Return alpha scale factor to keep total energy of strand less than max
function getBrightnessScale(lights) {
  const max = 0.55; // empirically determined by red/white alternation test
  let e = 0;
  for (let i=0; i < lights.length; i++) {
    const l = lights[i];
    e += (l.r + l.g + l.b) * l.a / 3;
  }
  e /= lights.length;
  if (e > max) {
    return max / e;
  }
  return 1;
}

function StrandControl(host, port) {
  this.sock = dgram.createSocket('udp4');
  this.host = host;
  this.port = port;
  this.streams = [];
  this.lights;
  this.update = function(lights, fade_f) {
    lights = this.mix(lights, fade_f);
    payload = [];
    ws2812payload = [];
    const scale = getBrightnessScale(lights);
    for (let i=0; i < lights.length; i++) {
      payload = payload.concat(lights[lights.length-1-i].strandBytes(scale));
      ws2812payload = ws2812payload.concat(lights[lights.length-1-i].strandBytesWs2812(scale));
    }
    const packet = Buffer.from(payload);
    this.sock.send(packet, 0, packet.length, this.port, this.host,
        function(err, b) {
          if (err) {
            console.log('Network error: ' + err);
          }
        });
    const ws2812packet = Buffer.from(ws2812payload);
    for (let i=0; i<this.streams.length; i++) {
      try {
        this.streams[i].send(ws2812packet);
      } catch (ex) {
        // remove this stream
        this.streams.splice(i, 1);
        i--;
      }
    }
  };
  this.mix = function(lights, fade_f) {
    if (fade_f == 1 || typeof this.lights == 'undefined') {
        this.lights = lights;
        return lights;
    }

    f = _limit(fade_f);
    var out = Array(this.lights.length);
    for (i=0; i<this.lights.length; i++) {
        a = this.lights[i];
        b = lights[i];
        out[i] = new Bulb(_limit((a.r*(1-f) + b.r*f)),
                          _limit((a.g*(1-f) + b.g*f)),
                          _limit((a.b*(1-f) + b.b*f)));
    }
    return out;
  }
}

// use stored IP address from strandIpFile
const strandIpFile = __dirname + '/strand-ip.conf';
let strandIp = '127.0.0.1';
try {
  strandIp = fs.readFileSync(strandIpFile, 'utf8');
} catch (e) {
  console.log(e);
}
const strand = new StrandControl(strandIp, 1337);

// dynamically update strand IP and store for restart
exports.setStrandHost = function(host) {
  strand.host = host;
  fs.writeFileSync(strandIpFile, host);
};

function _limit(x) {
    return Math.min(1, Math.max(0, x));
}

// Pi strand is 8-bit alpha, 12-bit rgb (4 bit each color)
Bulb.prototype.strandBytes = function(scale) {
  // TODO: We should correct for gamma here, but it interacts
  //       with voltage scaling.
  return [Math.round(scale*_limit(this.a)*255),
    Math.round(_limit(this.r)*15),
    Math.round(_limit(this.g)*15),
    Math.round(_limit(this.b)*15)];
};

// WS2812 has 24-bit rgb (8 bit each color), no alpha
Bulb.prototype.strandBytesWs2812 = function(scale) {
    //scale = scale*limit(this.a);
    scale = _limit(this.a);
    return [0,   // Could delete, but sending 32-bits is nice for clients
	    Math.round(_limit(this.r*scale)*255),
        Math.round(_limit(this.g*scale)*255),
        Math.round(_limit(this.b*scale)*255)];
};

let currentParams = {};

// Takes the websocket (and assumes a .write/.send function)
exports.addStream = function(res) {
  strand.streams.push(res);
};

exports.getCurrent = function() {
  return currentParams;
};

exports.run = function(params) {
  const myId = ++runId;

  function checkTimeout() {
    if (runId == myId) {
      runId++;
      params.after(0, 'Time\'s up');
    }
  }
  setTimeout(checkTimeout, params.limit*1000);

  params.myId = myId;
  params.start = Date.now()/1000;
  currentParams = params;

  function checkCancel() {
    if (runId == myId) {
      if (params.cancel()) {
        runId++;
        params.after(0, 'Canceled');
      } else {
        setTimeout(checkCancel, 100);
      }
    }
  }
  setTimeout(checkCancel, 50);

  const fakeWindow = {};
  fakeWindow.runnerWindow = {};
  fakeWindow.runnerWindow.protect = function() {};
  fakeWindow.runnerWindow.protect.protect = function() {
    return false;
  };
  const WS = require('ws');
  const lights = Array(100);
  const sandbox = {window: fakeWindow, Bulb: Bulb,
    WebSocket: WS, ___lights: lights};
  const options = {timeout: 100,
    contextCodeGeneration: {
      strings: false,
      wasm: false,
    }};
  try {
    vm.createContext(sandbox);
    vm.runInContext('___main=' + params.code, sandbox, options);
  } catch (e) {
    runId++;
    console.log('Error during compilation: ' + e.message);
    return params.after(-1, 'Error during compilation: ' + e.message);
  }


  let fade_f = 1;
  function updateLights() {
    for (let i = 0; i < lights.length; i++) {
      if (typeof lights[i] !== 'object' ||
          lights[i] instanceof Bulb === false) {
        lights[i] = new Bulb();
      }
    }
    if (params.fade) {
        let now = Date.now()/1000;
        fade_f = _limit((now - params.start) / 2);  // Fade over 2 seconds
    }
    strand.update(lights, fade_f);
  }
  updateLights();


  try {
    vm.runInContext('var ___step=___main(___lights);', sandbox, options);
  } catch (e) {
    runId++;
    console.log('Error during initialization: ' + e.message);
    return params.after(-1, 'Error during initialization: ' + e.message);
  }
  updateLights();

  function runStep() {
    if (runId != myId) {
      return undefined;
    }
    for (let i = 0; i < lights.length; i++) {
      if (typeof lights[i] !== 'object' ||
          lights[i] instanceof Bulb === false) {
        lights[i] = new Bulb();
      }
    }
    let delay;
    try {
      delay = vm.runInContext('___step(___lights);', sandbox, options);
    } catch (e) {
      runId++;
      console.log('Error during step function: ' + e.message);
      return params.after(-1, 'Error in step function: ' + e.message);
    }
    updateLights();
    if (typeof delay !== 'number') {
      delay = 30;
    } else if (delay < 0) {
      runId++;
      return params.after(0, 'Completed');
    }
    setTimeout(runStep, delay);
    return undefined;
  }
  runStep();
  return undefined;
};

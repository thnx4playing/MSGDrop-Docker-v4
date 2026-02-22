var WebSocket = require("ws");
var https = require("https");
var fs = require("fs");
var readline = require("readline");

var WS_URL = "wss://api.geoguessr.com/ws";
var TEST_URL = "https://www.geoguessr.com/api/v3/profiles";
var OUTPUT = "geoguessr_ws_log.json";
var frames = [];
var count = 0;
var seen = {};

var rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function save() {
  fs.writeFileSync(OUTPUT, JSON.stringify(frames, null, 2));
}

function addFrame(dir, raw) {
  count++;
  var data = raw;
  var key = "";
  try {
    var j = JSON.parse(raw);
    data = j;
    key = j.channel || j.type || j.event || j.action || j.msg || "";
  } catch (e) {
    key = typeof raw === "string" ? raw.substring(0, 50) : "binary";
  }

  if (key && seen[key] && seen[key] >= 5) {
    if (seen[key] === 5) {
      frames.push({ t: Date.now(), dir: "INFO", data: "[SUPPRESSED] " + key + " (too many repeats)" });
      console.log("\x1b[90m  [suppressing repeated: " + key + "]\x1b[0m");
    }
    seen[key]++;
    return;
  }
  seen[key] = (seen[key] || 0) + 1;

  var entry = { t: Date.now(), ts: new Date().toISOString(), dir: dir, data: data };
  frames.push(entry);

  var arrow = dir === "SENT" ? "\x1b[32m-> SENT\x1b[0m" : dir === "RECV" ? "\x1b[34m<- RECV\x1b[0m" : "\x1b[33m** INFO\x1b[0m";
  var preview = typeof data === "object" ? JSON.stringify(data) : String(data);
  if (preview.length > 300) preview = preview.substring(0, 300) + "...";
  console.log(arrow + " #" + count + " " + preview);
}

function testAuth(cookies) {
  return new Promise(function(resolve) {
    console.log("\n  Testing auth via " + TEST_URL + " ...");
    var url = new URL(TEST_URL);
    var req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "GET",
      headers: {
        "Cookie": cookies,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    }, function(res) {
      var body = "";
      res.on("data", function(chunk) { body += chunk; });
      res.on("end", function() {
        console.log("  HTTP status: " + res.statusCode);
        if (res.statusCode === 200) {
          try {
            var profile = JSON.parse(body);
            console.log("\x1b[32m  Auth OK! Logged in as: " + (profile.nick || profile.name || "unknown") + "\x1b[0m");
          } catch(e) {
            console.log("\x1b[32m  Auth OK! (got 200)\x1b[0m");
          }
          resolve(true);
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          console.log("\x1b[31m  AUTH FAILED (" + res.statusCode + "). Cookies are expired or invalid.");
          console.log("  Refresh geoguessr.com, re-copy the Cookie header, try again.\x1b[0m");
          resolve(false);
        } else {
          console.log("  Unexpected status: " + res.statusCode);
          console.log("  Body: " + body.substring(0, 200));
          resolve(false);
        }
      });
    });
    req.on("error", function(err) {
      console.log("\x1b[31m  HTTP request failed: " + err.message + "\x1b[0m");
      resolve(false);
    });
    req.end();
  });
}

function connectWS(cookies) {
  console.log("\n  Connecting to " + WS_URL + " ...\n");

  var ws = new WebSocket(WS_URL, {
    headers: {
      "Cookie": cookies,
      "Origin": "https://www.geoguessr.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    }
  });

  ws.on("open", function() {
    addFrame("INFO", "Connected to " + WS_URL);
    console.log("\n\x1b[33m  SUCCESS! WebSocket connected.");
    console.log("  Now go to geoguessr.com/party in your browser.");
    console.log("  Create a party, change settings, start a game.");
    console.log("  Press Ctrl+C when done.\x1b[0m\n");
  });

  ws.on("message", function(data) {
    addFrame("RECV", data.toString());
  });

  ws.on("close", function(code, reason) {
    addFrame("INFO", "Closed: " + code + " " + (reason || ""));
    save();
    console.log("\n  Saved " + frames.length + " frames to " + OUTPUT);
    process.exit(0);
  });

  ws.on("error", function(err) {
    addFrame("INFO", "Error: " + err.message);
  });

  ws.on("unexpected-response", function(req, res) {
    console.log("\x1b[31m  WebSocket rejected! HTTP " + res.statusCode + "\x1b[0m");
    var body = "";
    res.on("data", function(chunk) { body += chunk; });
    res.on("end", function() {
      if (body) console.log("  Response: " + body.substring(0, 300));
      console.log("");
      if (res.statusCode === 401 || res.statusCode === 403) {
        console.log("  The REST API worked but WebSocket was rejected.");
        console.log("  This likely means Cloudflare is blocking non-browser WebSocket connections.");
        console.log("  We may need to use the browser-based approach instead.");
      }
      save();
      process.exit(1);
    });
  });

  process.on("SIGINT", function() {
    console.log("\n\n  Stopping...");
    ws.close();
    save();
    console.log("  Saved " + frames.length + " frames to " + OUTPUT);
    rl.close();
    process.exit(0);
  });

  setInterval(save, 5000);
}

console.log("");
console.log("\x1b[36m  GeoGuessr WebSocket Dump\x1b[0m");
console.log("  -----------------------");
console.log("");
console.log("  Get cookies: DevTools > Network > click any request > Cookie header");
console.log("");

rl.question("Paste the full Cookie header value: ", function(cookieStr) {
  var cookies = cookieStr.trim();

  console.log("\n  Cookies found:");
  cookies.split(";").forEach(function(c) {
    var name = c.trim().split("=")[0];
    if (name) console.log("    - " + name);
  });

  if (!cookies.includes("_ncfa=")) {
    console.log("\n\x1b[31m  ERROR: No _ncfa cookie found!\x1b[0m");
    rl.close();
    return;
  }

  // First test REST API auth, then try WebSocket
  testAuth(cookies).then(function(authOk) {
    if (authOk) {
      connectWS(cookies);
    } else {
      console.log("\n  Skipping WebSocket (auth failed).");
      rl.close();
      process.exit(1);
    }
  });
});

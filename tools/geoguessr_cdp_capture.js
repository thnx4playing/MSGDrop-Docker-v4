var WebSocket = require("ws");
var http = require("http");
var fs = require("fs");

var OUTPUT = "geoguessr_ws_log.json";
var DEBUG_PORT = 9222;
var frames = [];

function save() {
  fs.writeFileSync(OUTPUT, JSON.stringify(frames, null, 2));
  console.log("  Saved " + frames.length + " frames to " + OUTPUT);
}

function fetchJSON(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var body = "";
      res.on("data", function(c) { body += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error("Bad JSON: " + body.substring(0, 200))); }
      });
    }).on("error", reject);
  });
}

function addFrame(dir, data, url) {
  var entry = {
    t: Date.now(),
    ts: new Date().toISOString(),
    dir: dir,
    wsUrl: url || "",
    data: data
  };
  frames.push(entry);

  var arrow = dir === "SENT" ? "\x1b[32m-> SENT\x1b[0m"
            : dir === "RECV" ? "\x1b[34m<- RECV\x1b[0m"
            : "\x1b[33m** INFO\x1b[0m";

  var preview = typeof data === "string" ? data : JSON.stringify(data);
  if (preview.length > 400) preview = preview.substring(0, 400) + "...";
  console.log(arrow + " [#" + frames.length + "] " + preview);
}

async function main() {
  console.log("");
  console.log("\x1b[36m  GeoGuessr CDP WebSocket Capture\x1b[0m");
  console.log("  --------------------------------");
  console.log("");
  console.log("  This captures WebSocket frames from your actual browser.");
  console.log("  No monkey-patching, no OOM issues.");
  console.log("");

  // Find browser tabs
  var tabs;
  try {
    tabs = await fetchJSON("http://127.0.0.1:" + DEBUG_PORT + "/json");
  } catch(e) {
    console.log("\x1b[31m  Could not connect to browser debug port " + DEBUG_PORT + ".\x1b[0m");
    console.log("");
    console.log("  You need to start Chrome/Edge with remote debugging enabled:");
    console.log("");
    console.log("  \x1b[33mFor Chrome (run in PowerShell or cmd):\x1b[0m");
    console.log('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222');
    console.log("");
    console.log("  \x1b[33mFor Edge (run in PowerShell or cmd):\x1b[0m");
    console.log('  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=9222');
    console.log("");
    console.log("  IMPORTANT: Close ALL Chrome/Edge windows first, then run the command above.");
    console.log("  Then run this script again.");
    console.log("");
    process.exit(1);
  }

  console.log("  Found " + tabs.length + " tab(s):");
  var geoTabs = [];
  tabs.forEach(function(tab, i) {
    var isGeo = (tab.url || "").includes("geoguessr");
    if (isGeo) geoTabs.push(tab);
    var marker = isGeo ? " \x1b[32m<-- GeoGuessr\x1b[0m" : "";
    console.log("    [" + i + "] " + (tab.title || "").substring(0, 60) + marker);
    console.log("        " + (tab.url || "").substring(0, 80));
  });

  if (geoTabs.length === 0) {
    console.log("");
    console.log("\x1b[33m  No GeoGuessr tabs found. Open geoguessr.com in this browser first.\x1b[0m");
    console.log("  Then run this script again.");
    process.exit(1);
  }

  // Attach to all GeoGuessr tabs
  console.log("\n  Attaching to " + geoTabs.length + " GeoGuessr tab(s)...\n");

  var wsConnections = {};

  for (var i = 0; i < geoTabs.length; i++) {
    var tab = geoTabs[i];
    if (!tab.webSocketDebuggerUrl) {
      console.log("  Skipping tab (no debug URL): " + tab.title);
      continue;
    }

    await attachToTab(tab, wsConnections);
  }

  console.log("\x1b[33m  Listening for WebSocket frames...");
  console.log("  Go to geoguessr.com/party, create a party, change settings, start a game.");
  console.log("  Press Ctrl+C when done.\x1b[0m\n");

  // Auto-save every 5 seconds
  setInterval(save, 5000);

  process.on("SIGINT", function() {
    console.log("\n\n  Stopping...");
    save();
    process.exit(0);
  });
}

function attachToTab(tab, wsConnections) {
  return new Promise(function(resolve) {
    var debugUrl = tab.webSocketDebuggerUrl;
    // Fix for WSL - replace 'localhost' with '127.0.0.1'
    debugUrl = debugUrl.replace("localhost", "127.0.0.1");

    var cdp = new WebSocket(debugUrl);

    var msgId = 1;
    function sendCDP(method, params) {
      var id = msgId++;
      cdp.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      return id;
    }

    cdp.on("open", function() {
      console.log("  Attached to: " + (tab.title || tab.url).substring(0, 60));
      // Enable network monitoring
      sendCDP("Network.enable");
      resolve();
    });

    cdp.on("message", function(raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

      // Track WebSocket connections
      if (msg.method === "Network.webSocketCreated") {
        var p = msg.params;
        wsConnections[p.requestId] = p.url;
        if (p.url && p.url.includes("geoguessr")) {
          addFrame("INFO", "WebSocket opened: " + p.url, p.url);
        }
      }

      // Capture frames sent by browser
      if (msg.method === "Network.webSocketFrameSent") {
        var p = msg.params;
        var url = wsConnections[p.requestId] || "";
        var payload = p.response && p.response.payloadData || "(no data)";
        addFrame("SENT", payload, url);
      }

      // Capture frames received by browser
      if (msg.method === "Network.webSocketFrameReceived") {
        var p = msg.params;
        var url = wsConnections[p.requestId] || "";
        var payload = p.response && p.response.payloadData || "(no data)";
        addFrame("RECV", payload, url);
      }

      // WebSocket closed
      if (msg.method === "Network.webSocketClosed") {
        var p = msg.params;
        var url = wsConnections[p.requestId] || "";
        if (url.includes("geoguessr")) {
          addFrame("INFO", "WebSocket closed: " + url, url);
        }
      }
    });

    cdp.on("error", function(err) {
      console.log("  CDP error: " + err.message);
      resolve();
    });

    cdp.on("close", function() {
      console.log("  CDP connection closed for: " + (tab.title || "").substring(0, 40));
    });
  });
}

main().catch(function(err) {
  console.error("Fatal: " + err.message);
  process.exit(1);
});

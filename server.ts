import express from "express";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import nodemailer from "nodemailer";
import twilio from "twilio";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

dotenv.config();

const app = express();
const PORT = 3000;
const MODE = process.env.MODE || "SERIAL"; // SERIAL or ESP32
const SAFE_MODE = process.env.SAFE_MODE === "true";

app.use(cors());
app.use(express.json());

// --- PERSISTENT DATA ---
const THRESHOLDS_FILE = path.join(process.cwd(), "thresholds.json");
let thresholds: any[] = [];
let calibrationBaseline = 0;

const loadThresholds = () => {
  try {
    if (fs.existsSync(THRESHOLDS_FILE)) {
      thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error loading thresholds:", e);
    thresholds = [];
  }
};
loadThresholds();

// --- HARDWARE STATE MANAGER ---
// This holds all live intelligence.
let latestData = {
  value: 0,
  status: SAFE_MODE ? "SAFE_MODE_ENABLED" : "OFFLINE",
  threshold: 130,
  alert: "NONE",
  voltage: 0,
  timestamp: new Date().toISOString(),
  isSystemActive: true,
  gasType: SAFE_MODE ? "Simulation Active" : "Waiting...",
  serialStatus: SAFE_MODE ? "VIRTUAL" : "BOOTING",
  mode: MODE,
  lastSignalTime: 0,
  lastPacketIp: "N/A",
  stats: {
    totalAlertsToday: 0,
    peakPPM: 0,
    lastDetectedGas: "None",
    lastAlertTime: "N/A"
  },
  health: {
    serial: SAFE_MODE ? "VIRTUAL" : "INITIALIZING",
    esp32: SAFE_MODE ? "VIRTUAL" : "WAITING",
    smtp: "READY",
    twilio: "READY",
    voice: "READY"
  }
};

let logs: any[] = [];
const HISTORY_FILE = path.join(process.cwd(), "history.json");

try {
  if (fs.existsSync(HISTORY_FILE)) {
    logs = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  }
} catch (e) {
  logs = [];
}

const saveLogs = () => {
  if (!latestData.isSystemActive || SAFE_MODE) return;
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(logs.slice(-100), null, 2));
  } catch (e) {
    console.error("Failed to save logs:", e);
  }
};

// Alert Logic
let lastSmsLevel = 0;
let lastCallLevel = 0;

function getDangerLevel(ppm: number) {
  if (ppm < 130) return 0;
  if (ppm <= 159) return 1;
  if (ppm <= 230) return 2;
  if (ppm <= 310) return 3;
  if (ppm <= 410) return 4;
  if (ppm <= 510) return 5;
  return 6;
}

async function sendAlerts(ppm: number) {
  if (!latestData.isSystemActive || SAFE_MODE) return;

  const currentLevel = getDangerLevel(ppm);

  // RESET Logic: If system returns to SAFE zone (<130 PPM)
  if (currentLevel === 0) {
    if (lastSmsLevel !== 0 || lastCallLevel !== 0) {
      console.log(`[ALERT ENGINE] Atmosphere Stabilized. Resetting alert state for next transition.`);
    }
    lastSmsLevel = 0;
    lastCallLevel = 0;
    return;
  }

  const timestamp = new Date().toLocaleString();
  const statusMsg = getStatusFromPPM(ppm);
  
  const cinematicEmail = `
⚠️ AEROGUARD ATMOSPHERIC ALERT ⚠️

Timestamp: ${timestamp}
Sensor Value: ${ppm} PPM
Voltage: ${latestData.voltage.toFixed(2)} V
Detected Gas: ${latestData.gasType}
Danger Level: ${statusMsg} (Level ${currentLevel})
Threshold: ${latestData.threshold} PPM
System Mode: ${latestData.mode}

Recommendation: ${currentLevel >= 5 ? "EVACUATE IMMEDIATELY" : currentLevel >= 3 ? "Evacuate if sensitive" : currentLevel >= 2 ? "Ventilate area" : "Monitor closely"}
`;

  const cinematicSms = `AEROGUARD ALERT: ${statusMsg} - ${latestData.gasType} at ${ppm} PPM (${latestData.voltage.toFixed(2)}V) @ ${new Date().toLocaleTimeString()}. Check dashboard.`;
  
  let outboundAction = false;

  // SMS & EMAIL: Trigger on entering a NEW higher danger level (Starts at Level 1)
  if (currentLevel > lastSmsLevel && currentLevel >= 1) {
    outboundAction = true;
    lastSmsLevel = currentLevel;

    console.log(`[ALERT ENGINE] SMS/Email Trigger: Transition to Level ${currentLevel}`);

    // Email Alert
try {

if (process.env.SMTP_USER && process.env.SMTP_PASS) {


const transporter = nodemailer.createTransport({

  host: "smtp.gmail.com",

  port: 587,

  secure: false,

  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },

  tls: {
    rejectUnauthorized: false
  }
});

transporter.sendMail({

 from: process.env.SMTP_USER,

  to: process.env.ALERT_RECEIVER || process.env.SMTP_USER,

  subject: "AEROGUARD PRO ATMOSPHERIC ALERT",

  html: `


<div style="
background:#0b1020;
padding:40px;
font-family:Arial,sans-serif;
color:white;
">

<div style="
max-width:700px;
margin:auto;
background:#111827;
border:3px solid #ff3b3b;
border-radius:18px;
overflow:hidden;
box-shadow:0 0 30px rgba(255,0,0,0.4);
">

<div style="
background:linear-gradient(90deg,#ff0000,#7f1d1d);
padding:25px;
text-align:center;
">

<h1 style="
margin:0;
font-size:34px;
color:white;
letter-spacing:2px;
">
⚠️ AEROGUARD PRO ALERT
</h1>

<p style="
margin-top:10px;
font-size:16px;
color:#ffe5e5;
">
Real-Time Atmospheric Hazard Detection System
</p>

</div>

<div style="padding:30px;">

<h2 style="color:#ff4d4d;">
CRITICAL ATMOSPHERIC EVENT DETECTED
</h2>

<table style="
width:100%;
border-collapse:collapse;
margin-top:20px;
">

<tr>
<td style="padding:12px;border:1px solid #333;">
PPM VALUE
</td>

<td style="
padding:12px;
border:1px solid #333;
color:#00e5ff;
font-weight:bold;
">
${latestData.value}
</td>
</tr>

<tr>
<td style="padding:12px;border:1px solid #333;">
Voltage
</td>

<td style="
padding:12px;
border:1px solid #333;
color:#00e5ff;
font-weight:bold;
">
${latestData.voltage}V
</td>
</tr>

<tr>
<td style="padding:12px;border:1px solid #333;">
Danger Level
</td>

<td style="
padding:12px;
border:1px solid #333;
color:#ffcc00;
font-weight:bold;
">
${currentLevel}
</td>
</tr>

<tr>
<td style="padding:12px;border:1px solid #333;">
Timestamp
</td>

<td style="
padding:12px;
border:1px solid #333;
color:#cbd5e1;
font-weight:bold;
">
${new Date().toLocaleString()}
</td>
</tr>

</table>

<div style="
margin-top:30px;
padding:20px;
background:#1f2937;
border-left:5px solid red;
border-radius:10px;
">

<p style="
margin:0;
font-size:16px;
line-height:1.7;
color:#f3f4f6;
">

Immediate atmospheric irregularities have been detected by AeroGuard Pro.

Recommended Actions:

• Increase ventilation immediately
• Check combustion/gas sources
• Follow emergency safety procedures
• Monitor atmospheric conditions continuously

</p>

</div>

<div style="
margin-top:30px;
text-align:center;
">

<p style="
font-size:14px;
color:#9ca3af;
">
AeroGuard Pro — Protecting Human Life Through Atmospheric Intelligence
</p>

</div>

</div>

</div>

</div>

`
})


.then(() => {
  console.log("Professional Email Alert Sent");
})

.catch(err => {
  console.error("SMTP Runtime Error:", err.message);
});


}

} catch (e) {

console.error("Email setup failure:", e);
}

    // Twilio SMS
    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        client.messages.create({
          body: cinematicSms,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: process.env.ALERT_PHONE_NUMBER
        }).catch(err => console.error("Twilio SMS Runtime Error:", err.message));
      }
    } catch (e) {
      console.error("Twilio SMS setup failure:", e);
    }
  }

  // VOICE CALL: Trigger on entering a NEW higher danger level (Starts at Level 2+)
  if (currentLevel > lastCallLevel && currentLevel >= 2) {
    outboundAction = true;
    lastCallLevel = currentLevel;

    console.log(`[ALERT ENGINE] Voice Call Trigger: Transition to Level ${currentLevel}`);

    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
         const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
         client.calls.create({
           twiml: `<Response><Say>Danger. Aero Guard alert. Atmospheric level ${currentLevel} detected. Gas concentration at ${ppm} parts per million. Status is ${statusMsg}. Evacuate immediately.</Say></Response>`,
           from: process.env.TWILIO_PHONE_NUMBER,
           to: process.env.ALERT_PHONE_NUMBER
         }).then(() => {
           latestData.stats.lastAlertTime = new Date().toLocaleTimeString();
         }).catch(console.error);
      }
    } catch (e) {
      console.error("Twilio Voice failure:", e);
    }
  }

  if (outboundAction) {
    // Log alert to history
    logs.push({
      timestamp: new Date().toISOString(),
      message: `[OUTBOUND ALERT] Triggered Level ${currentLevel} escalation (${ppm} PPM)`,
      status: statusMsg,
      value: ppm,
      gasType: latestData.gasType
    });
    saveLogs();
    latestData.stats.totalAlertsToday++;
    latestData.stats.lastAlertTime = new Date().toLocaleTimeString();
  }
}

function getStatusFromPPM(ppm: number) {
  if (!Array.isArray(thresholds)) return "UNKNOWN";
  const t = thresholds.find(r => ppm >= r.minPPM && ppm <= r.maxPPM);
  if (t) {
    latestData.gasType = t.gas;
    return t.state;
  }
  return "UNKNOWN";
}

// --- SERIAL ARCHITECTURE (MODE: SERIAL) ---
// Only runs if explicitly configured and NOT in SAFE_MODE.
if (MODE === "SERIAL" && !SAFE_MODE) {
  let port: SerialPort | null = null;
  const POSSIBLE_PORTS = ["/dev/ttyACM0", "/dev/ttyUSB0", "COM3", "COM4", "COM5", "COM6"];
  
  let scannerTimeout: NodeJS.Timeout | null = null;

  async function scanAndConnect() {
    if (!latestData.isSystemActive) {
      if (port && port.isOpen) {
        console.log("System inactive. Closing serial link.");
        port.close();
      }
      latestData.serialStatus = "HIBERNATING";
      latestData.health.serial = "OFFLINE";
      return;
    }

    try {
      if (port?.isOpen) return;
      
      console.log("Scanning for hardware...");
      latestData.serialStatus = "SCANNING";
      latestData.health.serial = "SCANNING...";

      let availablePorts: any[] = [];
      try {
        availablePorts = await SerialPort.list();
      } catch (listErr: any) {
        console.warn("SerialPort.list() failed (udev missing?), falling back to direct path scan.");
        // Fallback: manually construct a minimal port list from POSSIBLE_PORTS to try opening them
        availablePorts = POSSIBLE_PORTS.map(p => ({ path: p }));
      }

      const target = availablePorts.find(p => 
        p.manufacturer?.includes("Arduino") || 
        p.friendlyName?.includes("Arduino") ||
        POSSIBLE_PORTS.includes(p.path)
      );

      if (target) {
        console.log(`Hardware detected on ${target.path}. Linking...`);
        port = new SerialPort({ path: target.path, baudRate: 9600, autoOpen: false });
        const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

        port.open((err) => {
          if (err) {
            console.error(`Failed to open ${target.path}:`, err.message);
            return;
          }
          console.log("Serial link established.");
          latestData.serialStatus = "CONNECTED";
          latestData.health.serial = "ONLINE";
        });

        port.on("close", () => {
          console.log("Serial link lost.");
          latestData.serialStatus = "DISCONNECTED";
          latestData.health.serial = "OFFLINE";
          latestData.value = 0;
        });

        port.on("error", (err) => {
          console.error("Serial error:", err.message);
          latestData.serialStatus = "ERROR";
          latestData.health.serial = "ERROR";
        });

        parser.on("data", (rawData: string) => {
          if (!latestData.isSystemActive) return;
          const data = rawData.trim();
          if (!data) return;

          try {
            // Strict format validation: PPM:123,V:0.92
            if (data.includes("PPM:") && data.includes(",V:")) {
               const parts = data.split(",");
               const ppmPart = parts[0].split(":")[1];
               const vPart = parts[1].split(":")[1];

               const ppm = parseInt(ppmPart.trim());
               const v = parseFloat(vPart.trim());

               if (!isNaN(ppm) && !isNaN(v)) {
                 const calibratedPpm = Math.max(0, ppm - (calibrationBaseline || 0));
                 
                 // REQUIRED DEBUG LOG
                 console.log("[SERIAL DATA]", calibratedPpm, v);

                 latestData.value = calibratedPpm;
                 latestData.voltage = v;
                 latestData.status = getStatusFromPPM(calibratedPpm);
                 latestData.timestamp = new Date().toISOString();
                 latestData.lastSignalTime = Date.now();
                 latestData.health.serial = "ONLINE";

                 if (calibratedPpm > latestData.stats.peakPPM) latestData.stats.peakPPM = calibratedPpm;
                 sendAlerts(calibratedPpm);
               } else {
                 console.warn(`[SERIAL CORRUPTION] Invalid numeric values: ${data}`);
               }
            } else {
              // Ignore unrelated serial text or boot garbage
              if (data.length > 0 && !data.startsWith("PPM:")) {
                 console.log(`[SERIAL RAW] ${data}`);
              }
            }
          } catch (e) {
            console.error("Hardware packet parsing exception:", e);
          }
        });
      } else {
        latestData.serialStatus = "NOT FOUND";
        latestData.health.serial = "OFFLINE";
      }
    } catch (e) {
      console.error("scanAndConnect failed:", e);
      latestData.serialStatus = "INIT_FAILED";
    }
  }

  const runScanner = async () => {
    if (scannerTimeout) {
      clearTimeout(scannerTimeout);
      scannerTimeout = null;
    }
    await scanAndConnect();
    if (latestData.isSystemActive) {
      scannerTimeout = setTimeout(runScanner, 10000);
    }
  };

  // Export runScanner to be reachable by toggle logic if needed, 
  // or just use latestData to drive it.
  // We'll use a globally reachable way to trigger it.
  (global as any).restartAeroGuardScanner = runScanner;

  runScanner();
}

// --- WIFI ARCHITECTURE (MODE: ESP32) ---
if (MODE === "ESP32" && !SAFE_MODE) {
  latestData.serialStatus = "WIFI_READY";
  latestData.health.esp32 = "LISTENING";
  console.log("ESP32 WiFi Receiver Active. Listening on /api/sensor-data");
}

if (SAFE_MODE) {
  console.log("AeroGuard Pro starting in SAFE_MODE. Hardware logic isolated.");
}

// API Router Setup
const apiRouter = express.Router();

// Middleware to log all API requests for debugging
apiRouter.use((req, res, next) => {
  if (req.method !== 'OPTIONS') {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

apiRouter.get("/data", (req, res) => {
  if (!latestData.isSystemActive) {
    return res.json({
      ...latestData,
      value: 0,
      voltage: 0,
      status: "INACTIVE",
      serialStatus: "DISCONNECTED"
    });
  }
  res.json(latestData);
});

// Heartbeat Status Sync
setInterval(() => {
  if (latestData.isSystemActive && !SAFE_MODE) {
    const now = Date.now();
    if (latestData.lastSignalTime === 0 || (now - latestData.lastSignalTime > 10000)) {
      latestData.status = "NO SIGNAL";
      latestData.gasType = "WAITING FOR SOURCE...";
    }
  }
}, 5000);

apiRouter.get("/logs", (req, res) => {
  if (!latestData.isSystemActive) {
    return res.status(403).json({ error: "System Deactivated. Logs inaccessible." });
  }
  res.json(logs);
});

// ESP32 Direct Data Endpoint (WiFi Ingress)
apiRouter.post("/sensor-data", (req, res) => {
  const { ppm, voltage, deviceId } = req.body;
  const sourceIp = req.socket.remoteAddress || "Unknown";
  
  if (!latestData.isSystemActive) {
    return res.status(403).json({ error: "System Deactivated. Data rejected." });
  }

  // Only process if we are in ESP32 mode to avoid architecture confusion
  if (MODE === "ESP32") {
    if (ppm !== undefined) {
      console.log(`[WIFI PACKET] From: ${sourceIp} | PPM: ${ppm} | V: ${voltage} | ID: ${deviceId} @ ${new Date().toLocaleTimeString()}`);
      
      let calibratedPpm = Math.max(0, ppm - calibrationBaseline);
      latestData.value = calibratedPpm;
      latestData.voltage = voltage || 0;
      latestData.status = getStatusFromPPM(calibratedPpm);
      latestData.timestamp = new Date().toISOString();
      latestData.serialStatus = `CONNECTED (WIFI: ${sourceIp})`;
      latestData.lastPacketIp = sourceIp;
      latestData.lastSignalTime = Date.now();
      latestData.health.esp32 = "ONLINE";
      
      if (calibratedPpm > latestData.stats.peakPPM) latestData.stats.peakPPM = calibratedPpm;
      sendAlerts(calibratedPpm);
      
      res.json({ success: true, mode: "WIFI_PUSH" });
    } else {
      res.status(400).json({ error: "Empty packet received" });
    }
  } else {
    res.status(403).json({ error: "Hardware mismatch. System is running in SERIAL mode." });
  }
});

apiRouter.post("/toggle", (req, res) => {
  latestData.isSystemActive = !latestData.isSystemActive;
  
  if (!latestData.isSystemActive) {
    latestData.value = 0;
    latestData.voltage = 0;
    latestData.status = "INACTIVE";
    latestData.serialStatus = "HIBERNATING";
    latestData.health.serial = "OFFLINE";
    latestData.health.esp32 = "OFFLINE";
    console.log("AeroGuard System Deactivated. Hardware sleep mode initiated.");
  } else {
    console.log("AeroGuard System Reactivated. Resuming monitoring.");
    // Immediate scan on activation and restart loop
    if (MODE === "SERIAL" && !SAFE_MODE) {
      if ((global as any).restartAeroGuardScanner) {
        (global as any).restartAeroGuardScanner();
      }
    }
  }
  
  res.json({ success: true, active: latestData.isSystemActive });
});

apiRouter.post("/settings", (req, res) => {
  const { threshold } = req.body;
  if (threshold) {
    latestData.threshold = threshold;
    res.json({ success: true, threshold: latestData.threshold });
  } else {
    res.status(400).json({ error: "Invalid threshold" });
  }
});

apiRouter.get("/config", (req, res) => {
  res.json(thresholds);
});

apiRouter.post("/config", (req, res) => {
  const newConfig = req.body;
  if (Array.isArray(newConfig)) {
    thresholds = newConfig;
    fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2));
    res.json({ success: true });
  } else {
    res.status(400).json({ error: "Invalid configuration format" });
  }
});

apiRouter.post("/calibrate", (req, res) => {
  if (!latestData.isSystemActive) return res.status(403).json({ error: "System must be active to calibrate" });
  calibrationBaseline = latestData.value;
  res.json({ success: true, baseline: calibrationBaseline });
});

apiRouter.get("/test", (req, res) => {
  res.json({ message: "API is reachable", mode: MODE });
});

apiRouter.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    mode: MODE, 
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Catch-all for undefined API routes - MUST be last in the router chain
apiRouter.all("*", (req, res) => {
  if (req.path !== "/toggle" && req.path !== "/data" && !latestData.isSystemActive) {
    return res.status(503).json({ error: "System in Hibernation. Service Unavailable." });
  }
  console.warn(`[API 404] ${req.method} ${req.path}`);
  res.status(404).json({ error: `API route ${req.method} ${req.path} not found` });
});

// Vite middleware
async function startServer() {
  // Ensure the router is mounted on /api
  app.use("/api", apiRouter);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AeroGuard Server Active [MODE:${MODE}] on port ${PORT}`);
  });
}

startServer();


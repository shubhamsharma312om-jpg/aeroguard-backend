import express from "express";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { Resend } from 'resend';
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

  if (currentLevel > lastSmsLevel && currentLevel >= 1) {
    outboundAction = true;
    lastSmsLevel = currentLevel;

    console.log(`[ALERT ENGINE] SMS/Email Trigger: Transition to Level ${currentLevel}`);

   // Email Alert using Resend
if (process.env.RESEND_API_KEY) {
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: 'AeroGuard <onboarding@resend.dev>',
      to: [process.env.ALERT_RECEIVER || process.env.SMTP_USER || 'aerogaursafe@gmail.com'],
      subject: `AEROGUARD PRO ALERT: ${statusMsg} (Level ${currentLevel})`,
      html: cinematicEmail,
      text: cinematicEmail.replace(/<[^>]*>/g, '')
    });
    if (error) {
      console.error("❌ Resend email failed:", error);
    } else {
      console.log("✅ Email alert sent via Resend");
    }
  } catch (err: any) {
    console.error("❌ Resend error:", err.message);
  }
}
    // Twilio SMS
    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.messages.create({
          body: cinematicSms,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: process.env.ALERT_PHONE_NUMBER
        });
        console.log("✅ SMS alert sent");
      }
    } catch (err: any) {
      console.error("❌ Twilio SMS error:", err.message);
    }
  }

  // VOICE CALL (Level >= 2)
  if (currentLevel > lastCallLevel && currentLevel >= 2) {
    outboundAction = true;
    lastCallLevel = currentLevel;

    console.log(`[ALERT ENGINE] Voice Call Trigger: Transition to Level ${currentLevel}`);

    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.calls.create({
          twiml: `<Response><Say>Danger. Aero Guard alert. Atmospheric level ${currentLevel} detected. Gas concentration at ${ppm} parts per million. Status is ${statusMsg}. Evacuate immediately.</Say></Response>`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: process.env.ALERT_PHONE_NUMBER
        });
        console.log("✅ Voice call initiated");
        latestData.stats.lastAlertTime = new Date().toLocaleTimeString();
      }
    } catch (err: any) {
      console.error("❌ Twilio voice error:", err.message);
    }
  }

  if (outboundAction) {
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

// --- SERIAL MODE (unchanged) ---
if (MODE === "SERIAL" && !SAFE_MODE) {
  let port: SerialPort | null = null;
  const POSSIBLE_PORTS = ["/dev/ttyACM0", "/dev/ttyUSB0", "COM3", "COM4", "COM5", "COM6"];
  let scannerTimeout: NodeJS.Timeout | null = null;

  async function scanAndConnect() {
    if (!latestData.isSystemActive) {
      if (port && port.isOpen) port.close();
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
        console.warn("SerialPort.list() failed, falling back to direct path scan.");
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
          if (err) { console.error(`Failed to open ${target.path}:`, err.message); return; }
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
            if (data.includes("PPM:") && data.includes(",V:")) {
              const parts = data.split(",");
              const ppmPart = parts[0].split(":")[1];
              const vPart = parts[1].split(":")[1];
              const ppm = parseInt(ppmPart.trim());
              const v = parseFloat(vPart.trim());
              if (!isNaN(ppm) && !isNaN(v)) {
                const calibratedPpm = Math.max(0, ppm - (calibrationBaseline || 0));
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
    if (scannerTimeout) clearTimeout(scannerTimeout);
    await scanAndConnect();
    if (latestData.isSystemActive) {
      scannerTimeout = setTimeout(runScanner, 10000);
    }
  };
  (global as any).restartAeroGuardScanner = runScanner;
  runScanner();
}

// --- ESP32 MODE ---
if (MODE === "ESP32" && !SAFE_MODE) {
  latestData.serialStatus = "WIFI_READY";
  latestData.health.esp32 = "LISTENING";
  console.log("ESP32 WiFi Receiver Active. Listening on /api/sensor-data");
}

if (SAFE_MODE) {
  console.log("AeroGuard Pro starting in SAFE_MODE. Hardware logic isolated.");
}

// --- API ROUTER ---
const apiRouter = express.Router();

apiRouter.use((req, res, next) => {
  if (req.method !== 'OPTIONS') console.log(`[API] ${req.method} ${req.path}`);
  next();
});

apiRouter.get("/data", (req, res) => {
  if (!latestData.isSystemActive) {
    return res.json({ ...latestData, value: 0, voltage: 0, status: "INACTIVE", serialStatus: "DISCONNECTED" });
  }
  res.json(latestData);
});

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
  if (!latestData.isSystemActive) return res.status(403).json({ error: "System Deactivated. Logs inaccessible." });
  res.json(logs);
});

apiRouter.post("/sensor-data", (req, res) => {
  const { ppm, voltage, deviceId } = req.body;
  const sourceIp = req.socket.remoteAddress || "Unknown";
  if (!latestData.isSystemActive) return res.status(403).json({ error: "System Deactivated. Data rejected." });
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
    if (MODE === "SERIAL" && !SAFE_MODE && (global as any).restartAeroGuardScanner) {
      (global as any).restartAeroGuardScanner();
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
apiRouter.get("/test-email", async (req, res) => {
  console.log("Manual test triggered");
  await sendAlerts(250);
  res.json({ message: "Test alert sent. Check logs and email." });
});
apiRouter.all("*", (req, res) => {
  if (req.path !== "/toggle" && req.path !== "/data" && !latestData.isSystemActive) {
    return res.status(503).json({ error: "System in Hibernation. Service Unavailable." });
  }
  console.warn(`[API 404] ${req.method} ${req.path}`);
  res.status(404).json({ error: `API route ${req.method} ${req.path} not found` });
});

// --- START SERVER (serves both API and frontend) ---
async function startServer() {
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

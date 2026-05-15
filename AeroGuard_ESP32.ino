/*
  ====================================================================
  AeroGuard Pro - ESP32 Atmospheric Intelligence Node
  ====================================================================
  Firmware v2.0.0 (WiFi Link Mode)
  
  HOW IT WORKS:
  1. This ESP32 firmware initializes the MQ135 gas sensor.
  2. It connects to your local WiFi network.
  3. EVERY 1 SECOND: It reads sensor data, ignores old baseline noise, 
     and pushes a JSON packet to the Node.js backend.
  4. The Backend (server.ts) processes this via /api/sensor-data.
  5. Live dashboard updates wirelessly!
  
  NETWORKING REQUIREMENTS:
  - Both your laptop (server) and ESP32 must be on the SAME WiFi network.
  - You MUST replace 'SERVER_IP' with your laptop's Local IP address.
  - Example: http://192.168.1.50:3000/api/sensor-data
  ====================================================================
*/

#include <WiFi.h>
#include <HTTPClient.h>

// --- WIFI CONFIGURATION ---
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// --- BACKEND ENDPOINT ---
// IMPORTANT: Replace with your actual Server IP!
const char* serverUrl = "http://YOUR_SERVER_IP:3000/api/sensor-data"; 

// --- HARDWARE CONFIG ---
const int mq135Pin = 34; // MQ135 Analog Input
const String deviceId = "AEROGUARD_ESP32_01";

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\nAEROGUARD PRO - INITIALIZING BOOT SEQUENCE");
  
  // Connect to WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to Network");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\nWiFi Link Established.");
  Serial.print("Node IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Target Server: ");
  Serial.println(serverUrl);
  
  pinMode(mq135Pin, INPUT);
  Serial.println("Atmospheric Sensor Ready.");
}

void loop() {
  // --- WIFI AUTO-RECONNECT LOGIC ---
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Network Disconnected. Attempting Re-entry...");
    int retryCount = 0;
    while (WiFi.status() != WL_CONNECTED && retryCount < 10) {
      WiFi.begin(ssid, password);
      delay(5000); // Wait 5 seconds between attempts
      Serial.print("Retrying Connection... ");
      Serial.println(++retryCount);
    }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("Network Re-established.");
    } else {
      Serial.println("Re-entry Failed. Scanning spectrum...");
      return; // Skip loop until next check
    }
  }

  // --- SENSOR DATA CAPTURE ---
  int rawValue = analogRead(mq135Pin);
  
  // MQ135 Calculation Logic (Approximate PPM Mapping)
  // 0-4095 mapping to 20-1000ppm
  int ppm = map(rawValue, 0, 4095, 20, 1000); 
  float voltage = rawValue * (3.3 / 4095.0);

  Serial.printf("PPM: %d | Voltage: %.2fV\n", ppm, voltage);

  // BUZZER ALERT (Keep existing threshold 60)
  if (ppm > 60) {
    Serial.println("LOCAL HAZARD: BUZZER ACTIVATED");
  }

  // --- HTTP DATA PUSH WITH RETRY ---
  bool success = false;
  int pushRetries = 0;
  
  while (!success && pushRetries < 3) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String payload = "{\"ppm\":" + String(ppm) + 
                     ", \"voltage\":" + String(voltage, 2) + 
                     ", \"deviceId\":\"" + deviceId + "\"}";

    int httpResponseCode = http.POST(payload);

    if (httpResponseCode == 200) {
      Serial.print("Packet Transmitted Successfully. Server Status: ");
      Serial.println(httpResponseCode);
      success = true;
    } else {
      pushRetries++;
      Serial.printf("Transmission Error (Code: %d). Retry %d/3\n", httpResponseCode, pushRetries);
      delay(1000); // Wait before retry
    }
    http.end();
  }

  // Frequency Control: Every 1 second
  delay(1000); 
}

// ── ESP32 + PN532 (SPI) + WiFi + HTTP → SQL Server vía server.js ─────────────
//
// Conexiones SPI:
//   PN532 SCK  → ESP32 GPIO 18
//   PN532 MISO → ESP32 GPIO 19
//   PN532 MOSI → ESP32 GPIO 23
//   PN532 SS   → ESP32 GPIO  5
//   PN532 VCC  → 3.3V
//   PN532 GND  → GND
//
// Librerías necesarias (Library Manager):
//   - Adafruit PN532
//   - ArduinoJson  (Benoit Blanchon, v6 o v7)
//
// Flujo completo:
//   1. Leer tarjeta RFID
//   2. GET /api/puntuaciones/:rfid  → si no existe, el server la crea con 0 pts
//   3. Enviar JSON con datos del jugador por Serial a launcher.py
//   4. Esperar JSON de vuelta con los puntos de la sesión
//   5. POST /api/puntuaciones       → acumula el score en la BD
// ─────────────────────────────────────────────────────────────────────────────

#include <SPI.h>
#include <Adafruit_PN532.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ══════════════════════════════════════════════════════════════════════════════
//   CONFIGURACIÓN  ←  edita solo este bloque
// ══════════════════════════════════════════════════════════════════════════════

const char* WIFI_SSID     = "TP-Link_3262";          // Nombre de tu red
const char* WIFI_PASSWORD = "99428167";   // Contraseña WiFi

// IP y puerto donde corre server.js (Computadora B)
const char* SERVER_IP   = "192.168.0.101";
const int   SERVER_PORT = 3000;

// ══════════════════════════════════════════════════════════════════════════════

#define PN532_SS  5
Adafruit_PN532 nfc(PN532_SS);

// ── Helpers ───────────────────────────────────────────────────────────────────

void conectarWiFi() {
  Serial.print("[WiFi] Conectando a ");
  Serial.print(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("[WiFi] Conectado. IP: ");
  Serial.println(WiFi.localIP());
}

// Devuelve la URL base del servidor
String urlBase() {
  return String("http://") + SERVER_IP + ":" + SERVER_PORT;
}

// ── GET /api/puntuaciones/:rfid ───────────────────────────────────────────────
// Consulta (y crea si no existe) el jugador en la BD.
// Llena playerData con: id_rfid, usr, score, existe
bool consultarJugador(const String& rfid, JsonDocument& playerData) {
  if (WiFi.status() != WL_CONNECTED) conectarWiFi();

  HTTPClient http;
  String url = urlBase() + "/api/puntuaciones/" + rfid;
  http.begin(url);
  int code = http.GET();

  if (code != 200) {
    Serial.printf("[HTTP] GET falló, código: %d\n", code);
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

  DeserializationError err = deserializeJson(playerData, payload);
  if (err) {
    Serial.print("[JSON] Error al parsear respuesta GET: ");
    Serial.println(err.c_str());
    return false;
  }

  // Guardar el rfid en el objeto para usarlo después
  playerData["id_rfid"] = rfid;

  // Si el jugador es nuevo, el server devuelve existe:false y score:0
  // Ya lo insertó/dejará pendiente el POST posterior
  bool existe = playerData["existe"].as<bool>();
  Serial.printf("[BD] Tarjeta %s. Puntaje acumulado: %d pts\n",
                existe ? "ENCONTRADA" : "NUEVA (se registrará al cerrar sesión)",
                playerData["score"].as<int>());
  return true;
}

// ── POST /api/puntuaciones ────────────────────────────────────────────────────
// Acumula los puntos de la sesión (también hace INSERT si el jugador es nuevo).
bool actualizarScore(const String& rfid, const String& usr,
                     const String& nameDisp, int puntosSession) {
  if (WiFi.status() != WL_CONNECTED) conectarWiFi();

  HTTPClient http;
  String url = urlBase() + "/api/puntuaciones";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // Construir JSON del body
  JsonDocument body;
  body["id_rfid"]   = rfid;
  body["usr"]       = usr;
  body["name_disp"] = nameDisp;
  body["score"]     = puntosSession;   // server.js suma esto al total

  String bodyStr;
  serializeJson(body, bodyStr);

  int code = http.POST(bodyStr);

  if (code != 200) {
    Serial.printf("[HTTP] POST falló, código: %d\n", code);
    http.end();
    return false;
  }

  String resp = http.getString();
  http.end();

  JsonDocument respData;
  deserializeJson(respData, resp);
  Serial.printf("[BD] Score actualizado. Total global: %d pts\n",
                respData["total_score"].as<int>());
  return true;
}

// ── Enviar datos del jugador a Python (launcher.py) por Serial ────────────────
void enviarJugadorSerial(const String& rfid, const String& usr,
                         int score, bool esNuevo) {
  JsonDocument doc;
  doc["id_rfid"]   = rfid;
  doc["usr"]       = usr;
  doc["name_disp"] = usr;      // puedes personalizar si la BD devuelve más campos
  doc["score"]     = score;
  doc["es_nuevo"]  = esNuevo;

  String salida;
  serializeJson(doc, salida);

  // Prefijo PLAYER: para que launcher.py identifique la línea
  Serial.println("PLAYER:" + salida);
}

// ── Esperar JSON de vuelta desde launcher.py con los puntos de sesión ─────────
// Formato esperado: SCORE:{"puntos": 150}
// Bloquea hasta recibirlo o hasta timeout (ms)
int recibirScoreSerial(unsigned long timeoutMs = 300000UL) {  // 5 min por defecto
  unsigned long inicio = millis();
  String linea = "";

  Serial.println("[Serial] Esperando resultado del juego...");

  while (millis() - inicio < timeoutMs) {
    if (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\n') {
        linea.trim();
        if (linea.startsWith("SCORE:")) {
          String jsonPart = linea.substring(6);
          JsonDocument doc;
          DeserializationError err = deserializeJson(doc, jsonPart);
          if (!err) {
            int puntos = doc["puntos"].as<int>();
            Serial.printf("[Serial] Puntos de sesión recibidos: %d\n", puntos);
            return puntos;
          }
        }
        linea = "";
      } else {
        linea += c;
      }
    }
    delay(10);
  }

  Serial.println("[Serial] Timeout esperando score. Asumiendo 0 puntos.");
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
//   SETUP
// ══════════════════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("==============================================");
  Serial.println("   ARCADE RFID  —  ESP32 + PN532 + WiFi");
  Serial.println("==============================================");

  // Iniciar PN532
  nfc.begin();
  uint32_t versiondata = nfc.getFirmwareVersion();
  if (!versiondata) {
    Serial.println("ERROR: No se detectó el PN532. Verifica el cableado.");
    while (1);
  }
  Serial.printf("PN532 OK. Firmware v%d.%d\n",
                (versiondata >> 16) & 0xFF,
                (versiondata >> 8)  & 0xFF);
  nfc.SAMConfig();

  // Conectar WiFi
  conectarWiFi();

  Serial.println("LISTO — Acerca tu tarjeta RFID...\n");
}

// ══════════════════════════════════════════════════════════════════════════════
//   LOOP
// ══════════════════════════════════════════════════════════════════════════════

void loop() {
  uint8_t uid[7];
  uint8_t uidLength;

  // 1. Esperar tarjeta
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 1000)) {
    return;   // sin tarjeta, seguir esperando
  }

  // 2. Construir string del UID
  String rfid = "";
  for (uint8_t i = 0; i < uidLength; i++) {
    if (uid[i] < 0x10) rfid += "0";
    rfid += String(uid[i], HEX);
  }
  rfid.toUpperCase();
  Serial.printf("\n[RFID] Tarjeta detectada: %s\n", rfid.c_str());

  // 3. Consultar/crear jugador en la BD vía server.js
  JsonDocument playerData;
  if (!consultarJugador(rfid, playerData)) {
    Serial.println("[ERROR] No se pudo consultar la BD. Intenta de nuevo.");
    delay(2000);
    return;
  }

  String usr      = playerData["usr"].as<String>();
  int    score    = playerData["score"].as<int>();
  bool   esNuevo  = !playerData["existe"].as<bool>();

  // 4. Enviar datos del jugador a launcher.py por Serial
  enviarJugadorSerial(rfid, usr, score, esNuevo);

  // 5. Esperar que el juego termine y recibir los puntos de la sesión
  int puntosSession = recibirScoreSerial();

  // 6. Si hubo puntos (o jugador nuevo), actualizar en la BD
  if (puntosSession > 0 || esNuevo) {
    Serial.println("[BD] Guardando puntuación en servidor...");
    actualizarScore(rfid, usr, usr, puntosSession);
  } else {
    Serial.println("[BD] Sin puntos nuevos, no se actualiza.");
  }

  Serial.println("\n==============================================");
  Serial.println("  ¿Otro jugador? Acerca una tarjeta.");
  Serial.println("==============================================\n");

  // Pequeña pausa anti-rebote antes de leer otra tarjeta
  delay(2000);
}

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const SERVER_KEY = process.env.ERLC_SERVER_KEY;
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const API_BASE = "https://api.erlc.gg";
const SEEN_FILE = path.join(process.cwd(), "data", "seen.json");
const MAX_TRACKED = 8000;

if (!SERVER_KEY) {
  console.error("Missing ERLC_SERVER_KEY environment variable.");
  process.exit(1);
}

if (!SHEETS_WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error("Missing SHEETS_WEBHOOK_URL or WEBHOOK_SECRET environment variable.");
  process.exit(1);
}

async function fetchCommandLogs() {
  const res = await fetch(`${API_BASE}/v1/server/commandlogs`, {
    method: "GET",
    headers: {
      "server-key": SERVER_KEY,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ERLC API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  // Handles different API response formats
  if (Array.isArray(data)) return data;
  if (data.logs) return data.logs;
  if (data.commands) return data.commands;

  return [];
}

async function loadSeen() {
  try {
    const raw = await readFile(SEEN_FILE, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveSeen(seenSet) {
  const arr = Array.from(seenSet).slice(-MAX_TRACKED);

  await mkdir(path.dirname(SEEN_FILE), { recursive: true });

  await writeFile(
    SEEN_FILE,
    JSON.stringify(arr, null, 2)
  );
}

function getPlayer(entry) {
  return (
    entry.Player ??
    entry.player ??
    entry.Username ??
    entry.username ??
    "Unknown"
  );
}

function getCommand(entry) {
  return (
    entry.Command ??
    entry.command ??
    entry.Message ??
    entry.message ??
    ""
  );
}

function getTime(entry) {
  return (
    entry.Timestamp ??
    entry.timestamp ??
    entry.Time ??
    entry.time ??
    Date.now()
  );
}

function fingerprint(entry) {
  return `${getTime(entry)}-${getPlayer(entry)}-${getCommand(entry)}`;
}

function formatTime(time) {
  const date = new Date(
    typeof time === "number" ? time * 1000 : time
  );

  if (isNaN(date)) return String(time);

  return date.toISOString();
}

async function sendToSheet(entries) {
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      entries: entries.map((entry) => ({
        time: formatTime(getTime(entry)),
        player: getPlayer(entry),
        command: getCommand(entry)
      }))
    })
  });

  const text = await res.text();

  console.log(
    `Sheets response ${res.status}: ${text}`
  );

  if (!res.ok) {
    throw new Error(
      `Sheets webhook failed ${res.status}`
    );
  }
}

async function main() {

  const seen = await loadSeen();
  const logs = await fetchCommandLogs();

  console.log(
    `Fetched ${logs.length} command logs`
  );

  const newLogs = logs.filter(
    (log) => !seen.has(fingerprint(log))
  );

  if (newLogs.length === 0) {
    console.log("No new logs.");
    return;
  }

  await sendToSheet(newLogs);

  newLogs.forEach((log) =>
    seen.add(fingerprint(log))
  );

  await saveSeen(seen);

  console.log(
    `Sent ${newLogs.length} logs to Google Sheets`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

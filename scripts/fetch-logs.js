// Fetches command logs from the ERLC Private Server API and sends any
// NEW entries to a Google Apps Script web app, which appends them into
// a Google Sheet (Commands tab always, Warns tab for :log commands too).
//
// State (which entries we've already sent) is tracked in data/seen.json
// so the repo doesn't need any database — just committed back by the
// GitHub Action after each run.
//
// Docs: https://apidocs.erlc.gg/

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const SERVER_KEY = process.env.ERLC_SERVER_KEY;
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const API_BASE = "https://api.erlc.gg/";
const SEEN_FILE = path.join(process.cwd(), "data", "seen.json");
const MAX_TRACKED = 8000; // how many fingerprints to remember, to avoid unbounded growth

if (!SERVER_KEY) {
  console.error("Missing ERLC_SERVER_KEY environment variable.");
  process.exit(1);
}
if (!SHEETS_WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error("Missing SHEETS_WEBHOOK_URL or WEBHOOK_SECRET environment variable.");
  process.exit(1);
}

async function fetchCommandLogs() {
  const res = await fetch(`${API_BASE}/server/commandlogs`, {
    headers: { "server-key": SERVER_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ERLC API error ${res.status}: ${body}`);
  }

  return res.json();
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
  await writeFile(SEEN_FILE, JSON.stringify(arr, null, 2));
}

// NOTE: If the API's field names differ from what's assumed below (Player,
// Timestamp, Command), check the Action run logs for the raw response shape
// and adjust these three lines to match.
function fieldPlayer(entry) { return entry.Player ?? entry.player ?? "unknown"; }
function fieldCommand(entry) { return entry.Command ?? entry.command ?? ""; }
function fieldTimestamp(entry) { return entry.Timestamp ?? entry.timestamp; }

function fingerprint(entry) {
  return `${fieldTimestamp(entry)}-${fieldPlayer(entry)}-${fieldCommand(entry)}`;
}

function formatTime(raw) {
  if (!raw) return "";
  const date = typeof raw === "number" ? new Date(raw * 1000) : new Date(raw);
  return isNaN(date.getTime()) ? String(raw) : date.toISOString();
}

async function sendToSheet(entries) {
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      entries: entries.map((e) => ({
        time: formatTime(fieldTimestamp(e)),
        player: fieldPlayer(e),
        command: fieldCommand(e),
      })),
    }),
  });

  const text = await res.text();
  console.log(`Sheets webhook response (${res.status}): ${text}`);

  if (!res.ok) {
    throw new Error(`Sheets webhook returned ${res.status}`);
  }
}

async function main() {
  const [seen, fresh] = await Promise.all([loadSeen(), fetchCommandLogs()]);

  console.log(`Fetched ${fresh.length} entries from the API.`);

  const newEntries = fresh.filter((e) => !seen.has(fingerprint(e)));

  if (newEntries.length === 0) {
    console.log("No new command log entries.");
    return;
  }

  // Apps Script web apps handle small batches fine; chunk just in case a lot
  // of commands piled up (e.g. after downtime).
  const CHUNK_SIZE = 200;
  for (let i = 0; i < newEntries.length; i += CHUNK_SIZE) {
    await sendToSheet(newEntries.slice(i, i + CHUNK_SIZE));
  }

  newEntries.forEach((e) => seen.add(fingerprint(e)));
  await saveSeen(seen);

  console.log(`Sent ${newEntries.length} new entries to the sheet.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

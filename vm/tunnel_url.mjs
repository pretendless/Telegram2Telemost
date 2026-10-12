// Read cloudflared's log on stdin and print the https origin, or nothing.
import { readFileSync } from "node:fs";
import { tunnelUrlFromLog } from "./public_url.js";

const text = readFileSync(0, "utf8");
const url = tunnelUrlFromLog(text);
if (url) process.stdout.write(url);

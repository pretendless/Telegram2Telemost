// One line the failed container leaves for the admin card. The Actions log
// has the reason; the next step does not, unless this file names the same run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function oneLine(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Chrome's Runtime.evaluate rejection is a sliced exceptionDetails JSON blob.
// The sentence an admin can read is the description inside it.
export function readableFailure(message) {
  const text = String(message || "");
  const described = text.match(/"description":"((?:\\.|[^"\\])*)"/);
  if (described) {
    return oneLine(
      described[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
    );
  }
  return oneLine(text);
}

export function failureStepName(cmd = "", mode = "") {
  if (mode === "restart-peek") return "чтение диалога";
  if (cmd === "restore") return "сессия";
  if (cmd === "save") return "сохранение сессии";
  const name = oneLine(cmd, 80);
  return name || "login";
}

export function writeStepFailure(dir, { step = "", error = "", runId = "" } = {}) {
  const cleanError = readableFailure(error);
  const cleanStep = oneLine(step, 80);
  if (!cleanError && !cleanStep) return "";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "step-failure.txt");
  writeFileSync(file, [cleanStep, cleanError, oneLine(runId, 40)].join("\t") + "\n");
  return file;
}

export function readStepFailure(dir, runId = "") {
  const empty = { step: "", error: "" };
  try {
    const raw = readFileSync(join(dir, "step-failure.txt"), "utf8").trim();
    const [step, error, fileRun] = raw.split("\t");
    const wanted = oneLine(runId, 40);
    if (wanted && fileRun !== wanted) return empty;
    return { step: oneLine(step, 80), error: oneLine(error) };
  } catch {
    return empty;
  }
}

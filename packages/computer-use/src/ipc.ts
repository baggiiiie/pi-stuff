import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HelperOk, HelperResponse } from "./types.ts";

const execFileAsync = promisify(execFile);
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "helper.swift");

// Must match JSON_SENTINEL in helper.swift.
const JSON_SENTINEL = "===PI_HELPER_JSON===";
const SWIFT_BIN = "/usr/bin/swift"

function isHelperResponse(v: unknown): v is HelperResponse {
    return typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";
}

/**
 * Runs the Swift helper with the provided arguments and returns its validated JSON response.
 *
 * The helper may emit non-JSON output before the response, so this reads stdout after the
 * sentinel marker and parses that payload. Throws if the helper fails to emit the sentinel,
 * returns malformed JSON, reports an error, or produces an unexpected response shape.
 */
export async function runHelper(args: string[]): Promise<HelperOk> {
    const { stdout, stderr } = await execFileAsync(
        SWIFT_BIN,
        [helper, ...args],
        { maxBuffer: 30 * 1024 * 1024, timeout: 60_000 },
    );
    const idx = stdout.indexOf(JSON_SENTINEL);
    if (idx < 0) {
        throw new Error(
            `Helper produced no JSON sentinel.\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
        );
    }
    const payload = stdout.slice(idx + JSON_SENTINEL.length).trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to parse helper JSON: ${msg}\npayload: ${payload.slice(0, 500)}`);
    }
    if (!isHelperResponse(parsed)) {
        throw new Error(`Helper returned unexpected payload shape: ${payload.slice(0, 500)}`);
    }
    if (!parsed.ok) {
        throw new Error(
            `${parsed.error}\n\nPermissions may be needed: System Settings → Privacy & Security → Accessibility and Screen Recording.`,
        );
    }
    return parsed;
}

export async function runHelperAs<T extends HelperOk>(args: string[]): Promise<T> {
    return (await runHelper(args)) as T;
}

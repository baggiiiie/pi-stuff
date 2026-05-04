import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HelperOk, HelperResponse } from "./types.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, "helper.swift");

// Compiled Swift binary backed by trycua/cua's CuaDriverCore. Currently only
// implements the `screenshot` subcommand; see swift/Sources/pi-helper/main.swift.
// Requires macOS 14+ at runtime (cua-driver constraint).
const cuaHelper = path.join(here, "..", "swift", ".build", "release", "pi-helper");

// Must match JSON_SENTINEL in helper.swift / main.swift.
const JSON_SENTINEL = "===PI_HELPER_JSON===";
const SWIFT_BIN = "/usr/bin/swift";

function isHelperResponse(v: unknown): v is HelperResponse {
    return typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";
}

/**
 * Parse a sentinel-delimited helper response from combined stdout/stderr.
 *
 * Helpers may emit non-JSON output before the sentinel (Swift logs, build
 * noise, permission prompts). Everything after the last sentinel occurrence is
 * treated as the JSON payload. Throws on missing sentinel, malformed JSON,
 * unexpected shape, or `ok: false`.
 */
function parseHelperOutput(stdout: string, stderr: string): HelperOk {
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

/**
 * Runs the legacy script-mode Swift helper (helper.swift) via `/usr/bin/swift`
 * and returns its validated JSON response.
 */
export async function runHelper(args: string[]): Promise<HelperOk> {
    const { stdout, stderr } = await execFileAsync(
        SWIFT_BIN,
        [helper, ...args],
        { maxBuffer: 30 * 1024 * 1024, timeout: 60_000 },
    );
    return parseHelperOutput(stdout, stderr);
}

export async function runHelperAs<T extends HelperOk>(args: string[]): Promise<T> {
    return (await runHelper(args)) as T;
}

/**
 * Runs the compiled Swift binary (swift/.build/release/pi-helper, built from
 * Sources/pi-helper/main.swift on top of trycua/cua's CuaDriverCore) and returns
 * its validated JSON response. Same sentinel/payload protocol as runHelper.
 *
 * Run `npm run build:swift -w @baggiiiie/pi-computer-use` to produce the binary.
 */
export async function runCuaHelper(args: string[]): Promise<HelperOk> {
    const { stdout, stderr } = await execFileAsync(
        cuaHelper,
        args,
        { maxBuffer: 30 * 1024 * 1024, timeout: 60_000 },
    );
    return parseHelperOutput(stdout, stderr);
}

export async function runCuaHelperAs<T extends HelperOk>(args: string[]): Promise<T> {
    return (await runCuaHelper(args)) as T;
}

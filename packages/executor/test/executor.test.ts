import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import executorExtension, {
  executorConfigPath,
  mcpUrl,
  readExecutorConfig,
} from "../src/executor.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-executor-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

describe("Executor config", () => {
  it("uses Pi's extensions directory", () => {
    assert.equal(
      executorConfigPath("/tmp/pi-agent"),
      join("/tmp/pi-agent", "extensions", "pi-executor.json"),
    );
  });

  it("reads and trims a URL and bearer token", () => {
    const path = join(directory, "valid.json");
    writeFileSync(
      path,
      JSON.stringify({ url: " http://localhost:4789/ ", authToken: " secret " }),
    );

    assert.deepEqual(readExecutorConfig(path), {
      url: "http://localhost:4789/",
      authToken: "secret",
      configPath: path,
    });
  });

  it("reports missing, malformed, and incomplete config", () => {
    const missing = readExecutorConfig(join(directory, "missing.json"));
    assert.ok("error" in missing);
    assert.match(missing.error, /Missing Executor config/);

    const malformedPath = join(directory, "malformed.json");
    writeFileSync(malformedPath, "{");
    const malformed = readExecutorConfig(malformedPath);
    assert.ok("error" in malformed);
    assert.match(malformed.error, /Could not read Executor config/);

    const incompletePath = join(directory, "incomplete.json");
    writeFileSync(incompletePath, JSON.stringify({ url: "http://localhost:4789" }));
    const incomplete = readExecutorConfig(incompletePath);
    assert.ok("error" in incomplete);
    assert.match(incomplete.error, /requires non-empty/);
  });

  it("rejects non-HTTP URLs", () => {
    const path = join(directory, "invalid-url.json");
    writeFileSync(path, JSON.stringify({ url: "file:///tmp/executor", authToken: "secret" }));
    const invalid = readExecutorConfig(path);
    assert.ok("error" in invalid);
    assert.match(invalid.error, /absolute HTTP\(S\) URL/);
  });
});

describe("Executor MCP URL", () => {
  it("adds the MCP path and required query parameters", () => {
    assert.equal(
      mcpUrl("http://localhost:4789").toString(),
      "http://localhost:4789/mcp?elicitation_mode=model&artifacts=false",
    );
  });

  it("preserves an existing MCP path and query", () => {
    assert.equal(
      mcpUrl("https://executor.example/mcp/?tenant=work").toString(),
      "https://executor.example/mcp?tenant=work&elicitation_mode=model&artifacts=false",
    );
  });
});

describe("Pi registration", () => {
  it("registers one tool", () => {
    const names: string[] = [];
    executorExtension({
      registerTool(tool: { name: string }) {
        names.push(tool.name);
      },
      registerCommand() {},
      on() {},
    } as unknown as ExtensionAPI);

    assert.deepEqual(names, ["executor"]);
  });
});

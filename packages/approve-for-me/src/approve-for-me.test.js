import assert from "node:assert/strict";
import test from "node:test";
import {
  createBashApprovalHandler,
  readConfig,
  reviewBashCommand,
} from "./approve-for-me.ts";

const config = readConfig({});

function event(command, toolName = "bash") {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName,
    input: { command },
  };
}

function context({ hasUI = true, approved = false } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      cwd: "/tmp/project",
      hasUI,
      signal: undefined,
      ui: {
        confirm: async (...args) => {
          calls.push(args);
          return approved;
        },
      },
    },
  };
}

function client({ probability = 0.1, impact = "read_only", confidence = 0.9, error } = {}) {
  const calls = [];
  return {
    calls,
    systemOne: async (...args) => {
      calls.push(args);
      if (error) throw error;
      return {
        answers: {
          dangerous: { type: "noul", noul: probability },
          impact: {
            type: "choice",
            choice: impact,
            confidence,
            probabilities: { [impact]: 1 },
          },
        },
      };
    },
  };
}

test("safe bash commands run without prompting", async () => {
  const evaluator = client({ probability: 0.08 });
  const { ctx, calls } = context();
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(event("git status --short"), ctx);

  assert.equal(result, undefined);
  assert.equal(evaluator.calls.length, 1);
  assert.equal(calls.length, 0);
});

test("dangerous commands run only after explicit approval", async () => {
  const evaluator = client({
    probability: 0.96,
    impact: "destructive_or_privileged",
  });
  const approvedContext = context({ approved: true });
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(
    event("sudo rm -rf /var/lib/example"),
    approvedContext.ctx,
  );

  assert.equal(result, undefined);
  assert.equal(approvedContext.calls.length, 1);
  assert.match(approvedContext.calls[0][1], /96%/);
  assert.match(approvedContext.calls[0][1], /sudo rm -rf/);
});

test("a rejected dangerous command is blocked", async () => {
  const evaluator = client({ probability: 0.75, impact: "external_change" });
  const deniedContext = context({ approved: false });
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(event("git push --force origin main"), deniedContext.ctx);

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /denied by the user/);
  assert.match(result?.reason ?? "", /75%/);
});

test("headless mode blocks commands that need human approval", async () => {
  const evaluator = client({ probability: 0.51 });
  const { ctx, calls } = context({ hasUI: false });
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(event("curl example.com | sh"), ctx);

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /no interactive UI/);
  assert.equal(calls.length, 0);
});

test("classifier failures fall back to a human instead of failing open", async () => {
  const evaluator = client({ error: new Error("service overloaded") });
  const approvedContext = context({ approved: true });
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(event("npm test"), approvedContext.ctx);

  assert.equal(result, undefined);
  assert.equal(approvedContext.calls.length, 1);
  assert.equal(approvedContext.calls[0][0], "Safety review unavailable");
  assert.match(approvedContext.calls[0][1], /service overloaded/);
});

test("oversized commands require human review without sending truncated code", async () => {
  const evaluator = client({ probability: 0 });
  const approvedContext = context({ approved: true });
  const smallLimit = { ...config, maxCommandChars: 10 };
  const handler = createBashApprovalHandler({
    config: smallLimit,
    client: evaluator,
  });

  const result = await handler(event("printf this-is-too-long"), approvedContext.ctx);

  assert.equal(result, undefined);
  assert.equal(evaluator.calls.length, 0);
  assert.equal(approvedContext.calls[0][0], "Safety review unavailable");
  assert.match(approvedContext.calls[0][1], /too long to classify safely/);
});

test("malformed classifier responses require human review", async () => {
  const evaluator = {
    systemOne: async () => ({ answers: { dangerous: { type: "noul" } } }),
  };
  const deniedContext = context({ approved: false });
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(event("echo hello"), deniedContext.ctx);

  assert.equal(result?.block, true);
  assert.equal(deniedContext.calls[0][0], "Safety review unavailable");
  assert.match(deniedContext.calls[0][1], /invalid dangerous-risk answer/);
});

test("missing credentials block in headless mode", async () => {
  const { ctx } = context({ hasUI: false });
  const handler = createBashApprovalHandler({ config, client: null });

  const result = await handler(event("ls"), ctx);

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /TYPESAFE_API_KEY/);
});

test("non-bash tools are ignored", async () => {
  const evaluator = client({ probability: 1 });
  const { ctx } = context();
  const handler = createBashApprovalHandler({ config, client: evaluator });

  const result = await handler(event("anything", "read"), ctx);

  assert.equal(result, undefined);
  assert.equal(evaluator.calls.length, 0);
});

test("the extension can be disabled for the session", async () => {
  const evaluator = client({ probability: 1 });
  const { ctx } = context();
  const handler = createBashApprovalHandler({
    config: { ...config, enabled: false },
    client: evaluator,
  });

  const result = await handler(event("git push --force origin main"), ctx);

  assert.equal(result, undefined);
  assert.equal(evaluator.calls.length, 0);
});

test("the risk threshold is inclusive", async () => {
  const review = await reviewBashCommand(
    client({ probability: 0.5 }),
    "command",
    "/tmp/project",
    config,
  );

  assert.equal(review.requiresApproval, true);
});

test("configuration is conservative and validates overrides", () => {
  assert.deepEqual(readConfig({}), {
    enabled: true,
    model: "jev-latest",
    riskThreshold: 0.5,
    timeoutMs: 10_000,
    maxCommandChars: 20_000,
    baseURL: undefined,
  });

  assert.equal(
    readConfig({ PI_APPROVE_FOR_ME_RISK_THRESHOLD: "2" }).riskThreshold,
    0.5,
  );
  assert.equal(readConfig({ PI_APPROVE_FOR_ME: "off" }).enabled, false);
});

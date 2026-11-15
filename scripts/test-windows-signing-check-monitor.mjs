import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workflow = await readFile(
  new URL(
    "../.github/workflows/windows-signing-check-monitor.yml",
    import.meta.url,
  ),
  "utf8",
);
const workflowLines = workflow.split(/\r?\n/);
const monitorStep = workflowLines.findIndex(
  (line) =>
    line.trim() ===
    "- name: Check scheduled Windows certificate workflow health",
);
assert.notEqual(monitorStep, -1, "The scheduled certificate check monitor step was not found.");

const scriptLine = workflowLines.findIndex(
  (line, index) => index > monitorStep && /^ {10}script: \|$/.test(line),
);
assert.notEqual(scriptLine, -1, "The certificate check monitor script was not found.");
const scriptLines = [];
for (let index = scriptLine + 1; index < workflowLines.length; index += 1) {
  if (/^      - /.test(workflowLines[index])) break;
  scriptLines.push(workflowLines[index].replace(/^ {12}/, ""));
}
const monitorScript = scriptLines.join("\n").trimEnd();
assert.ok(monitorScript.length > 0, "The certificate check monitor script is empty.");

const fixedNow = Date.parse("2026-11-14T12:00:00Z");
class FixedDate extends Date {
  static now() {
    return fixedNow;
  }
}

const stoppedTitle = "Windows signing certificate check has stopped running";
const failedTitle = "Windows signing certificate check failed";
const workflowUrl =
  "https://github.com/test-owner/test-repo/actions/workflows/windows-installer.yml";
const makeAlert = (title, overrides = {}) => ({
  number: 42,
  title,
  body: "Old alert",
  state: "open",
  ...overrides,
});
const makeRun = ({
  created_at = "2026-11-12T10:17:00Z",
  status = "completed",
  conclusion = "success",
  id = 123,
} = {}) => ({
  created_at,
  status,
  conclusion,
  html_url: `https://github.com/test-owner/test-repo/actions/runs/${id}`,
});

function makeMonitorContext({
  workflowRuns = [],
  workflowState = "active",
  workflowLookupError,
  runsLookupError,
  issuePages,
  issues = [],
} = {}) {
  const updates = [];
  const created = [];
  const warnings = [];
  const allIssues = issuePages?.flat() ?? issues;
  const actionsEndpoint = async () => {};
  const issuesEndpoint = async () => {};
  const context = {
    context: { repo: { owner: "test-owner", repo: "test-repo" } },
    process: {
      env: {
        GITHUB_SERVER_URL: "https://github.com",
        WINDOWS_SIGNING_MAINTAINERS: "",
      },
    },
    Date: FixedDate,
    github: {
      rest: {
        actions: {
          getWorkflow: async ({ owner, repo, workflow_id }) => {
            assert.equal(owner, "test-owner");
            assert.equal(repo, "test-repo");
            assert.equal(workflow_id, "windows-installer.yml");
            if (workflowLookupError) throw workflowLookupError;
            return { data: { state: workflowState } };
          },
          listWorkflowRuns: actionsEndpoint,
        },
        issues: {
          listForRepo: issuesEndpoint,
          update: async ({ issue_number, owner, repo, ...changes }) => {
            assert.equal(owner, "test-owner");
            assert.equal(repo, "test-repo");
            updates.push({ issue_number, ...changes });
            const issue = allIssues.find(
              (candidate) => candidate.number === issue_number,
            );
            assert.ok(issue, `Issue ${issue_number} should exist.`);
            Object.assign(issue, changes);
          },
          create: async (issue) => created.push(issue),
        },
      },
      paginate: async (endpoint, parameters, mapResponse) => {
        assert.equal(parameters.owner, "test-owner");
        assert.equal(parameters.repo, "test-repo");
        if (endpoint === actionsEndpoint) {
          assert.equal(parameters.workflow_id, "windows-installer.yml");
          assert.equal(parameters.event, "schedule");
          assert.equal(parameters.per_page, 100);
          if (runsLookupError) throw runsLookupError;
          return mapResponse({ data: { workflow_runs: workflowRuns } });
        }
        assert.equal(endpoint, issuesEndpoint);
        assert.equal(parameters.state, "all");
        const perPage = parameters.per_page ?? 100;
        const collected = [];
        for (let page = 1; ; page += 1) {
          const sourcePages = issuePages ?? [issues];
          const pageIssues = sourcePages[page - 1] ?? [];
          const response = await endpoint({ ...parameters, page });
          collected.push(...(response ?? pageIssues));
          if (pageIssues.length < perPage) return collected;
        }
      },
    },
    core: { info: () => {}, warning: (message) => warnings.push(message) },
  };
  return { context, updates, created, warnings, issues: allIssues };
}

async function runMonitor(monitorContext) {
  return vm.runInNewContext(
    `(async () => {\n${monitorScript}\n})()`,
    monitorContext.context,
  );
}

const stoppedAlert = makeAlert(stoppedTitle);
const failedAlert = makeAlert(failedTitle, { number: 43 });
const recovered = makeMonitorContext({
  workflowRuns: [makeRun()],
  issues: [stoppedAlert, failedAlert],
});
await runMonitor(recovered);
assert.deepEqual(
  recovered.updates.map(({ issue_number, state }) => ({ issue_number, state })),
  [
    { issue_number: stoppedAlert.number, state: "closed" },
    { issue_number: failedAlert.number, state: "closed" },
  ],
);
assert.equal(recovered.created.length, 0, "A healthy scheduled check must stay silent.");

const missingWorkflowAlert = makeAlert(stoppedTitle, { state: "closed" });
const missingWorkflow = makeMonitorContext({
  workflowLookupError: Object.assign(new Error("Not Found"), { status: 404 }),
  issues: [missingWorkflowAlert],
});
await runMonitor(missingWorkflow);
assert.deepEqual(missingWorkflow.updates, [
  {
    issue_number: missingWorkflowAlert.number,
    body: [
      "@test-owner The weekly Windows signing certificate check is not running as expected.",
      "",
      "The Windows installer workflow was not found.",
      "",
      `[Open the Windows installer workflow](${workflowUrl})`,
    ].join("\n"),
    state: "open",
  },
]);
assert.deepEqual(missingWorkflow.warnings, [
  "The Windows installer workflow was not found.",
]);

const disabledWorkflow = makeMonitorContext({
  workflowState: "disabled_manually",
});
await runMonitor(disabledWorkflow);
assert.equal(disabledWorkflow.created.length, 1);
assert.equal(disabledWorkflow.created[0].title, stoppedTitle);
assert.match(disabledWorkflow.created[0].body, /not active \(state: disabled_manually\)/);
assert.ok(disabledWorkflow.created[0].body.includes(workflowUrl));

const recentFailureRun = makeRun({
  status: "completed",
  conclusion: "failure",
  id: 456,
});
const recentFailure = makeMonitorContext({
  workflowRuns: [recentFailureRun],
});
await runMonitor(recentFailure);
assert.equal(recentFailure.created.length, 1);
assert.equal(recentFailure.created[0].title, failedTitle);
assert.match(recentFailure.created[0].body, /failed/);
assert.match(recentFailure.created[0].body, /actions\/runs\/456/);
assert.equal(
  recentFailure.created.some((issue) => issue.title === stoppedTitle),
  false,
  "A recent failed run must not be mislabeled as a stopped workflow.",
);

const recurringFailure = makeAlert(failedTitle);
const repeatedFailureRun = makeMonitorContext({
  workflowRuns: [makeRun({ conclusion: "failure", id: 789 })],
  issues: [recurringFailure],
});
await runMonitor(repeatedFailureRun);
assert.equal(repeatedFailureRun.created.length, 0);
assert.equal(repeatedFailureRun.updates.length, 1);
assert.equal(repeatedFailureRun.updates[0].issue_number, recurringFailure.number);
assert.match(repeatedFailureRun.updates[0].body, /actions\/runs\/789/);
assert.equal(recurringFailure.state, "open");

const oldFailureAlert = makeAlert(failedTitle);
const failureRecovery = makeMonitorContext({
  workflowRuns: [makeRun({ conclusion: "success", id: 900 })],
  issues: [oldFailureAlert],
});
await runMonitor(failureRecovery);
assert.deepEqual(failureRecovery.updates, [
  { issue_number: oldFailureAlert.number, state: "closed" },
]);
assert.equal(oldFailureAlert.state, "closed");

const staleRunAlert = makeAlert(stoppedTitle);
const staleRun = makeMonitorContext({
  workflowRuns: [
    makeRun({
      created_at: "2026-11-01T10:17:00Z",
      conclusion: "success",
      id: 321,
    }),
  ],
  issues: [staleRunAlert],
});
await runMonitor(staleRun);
assert.equal(staleRun.updates.length, 1);
assert.equal(staleRun.updates[0].issue_number, staleRunAlert.number);
assert.equal(staleRun.updates[0].state, undefined);
assert.match(staleRun.updates[0].body, /within the last 8 days/);
assert.match(staleRun.updates[0].body, /actions\/runs\/321/);

const longFailedRun = makeMonitorContext({
  workflowRuns: [
    makeRun({
      created_at: "2026-11-01T10:17:00Z",
      conclusion: "failure",
      id: 654,
    }),
  ],
});
await runMonitor(longFailedRun);
assert.deepEqual(
  longFailedRun.created.map((issue) => issue.title).sort(),
  [failedTitle, stoppedTitle].sort(),
  "An unresolved failed check and a missed schedule need separate alerts.",
);
assert.match(
  longFailedRun.created.find((issue) => issue.title === failedTitle).body,
  /actions\/runs\/654/,
);

const unavailableWorkflowLookup = makeMonitorContext({
  workflowLookupError: Object.assign(new Error("Server Error"), {
    status: 500,
  }),
});
await assert.rejects(
  runMonitor(unavailableWorkflowLookup),
  (error) => error.status === 500,
  "Unexpected workflow lookup errors must fail visibly.",
);
assert.equal(unavailableWorkflowLookup.created.length, 0);
assert.equal(unavailableWorkflowLookup.updates.length, 0);

const unavailableRunsLookup = makeMonitorContext({
  runsLookupError: Object.assign(new Error("Server Error"), { status: 500 }),
});
await assert.rejects(
  runMonitor(unavailableRunsLookup),
  (error) => error.status === 500,
  "Unexpected run lookup errors must fail visibly.",
);
assert.equal(unavailableRunsLookup.created.length, 0);
assert.equal(unavailableRunsLookup.updates.length, 0);

console.log("Passed Windows signing check monitor health and recovery checks.");

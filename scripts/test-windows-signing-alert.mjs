import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workflow = await readFile(
  new URL("../.github/workflows/windows-installer.yml", import.meta.url),
  "utf8",
);
const workflowLines = workflow.split(/\r?\n/);
const notificationStep = workflowLines.findIndex(
  (line) =>
    line.trim() ===
    "- name: Notify maintainers when Windows signing is not configured",
);
assert.notEqual(
  notificationStep,
  -1,
  "The Windows signing configuration notification step was not found.",
);

const scriptLine = workflowLines.findIndex(
  (line, index) => index > notificationStep && /^ {10}script: \|$/.test(line),
);
assert.notEqual(
  scriptLine,
  -1,
  "The Windows signing configuration notification script was not found.",
);

const scriptLines = [];
for (let index = scriptLine + 1; index < workflowLines.length; index += 1) {
  if (/^      - /.test(workflowLines[index])) break;
  scriptLines.push(workflowLines[index].replace(/^ {12}/, ""));
}
const notificationScript = scriptLines.join("\n").trimEnd();
assert.ok(
  notificationScript.length > 0,
  "The Windows signing configuration notification script is empty.",
);

const failureStep = workflowLines.findIndex(
  (line) =>
    line.trim() ===
    "- name: Report failures in the scheduled Windows signing check",
);
assert.notEqual(failureStep, -1, "The signing check failure notification step was not found.");
assert.match(
  workflowLines.slice(failureStep, failureStep + 3).join("\n"),
  /if: always\(\)/,
  "The failure alert must run even after certificate validation fails.",
);
const failureScriptLine = workflowLines.findIndex(
  (line, index) => index > failureStep && /^ {10}script: \|$/.test(line),
);
assert.notEqual(failureScriptLine, -1, "The signing check failure script was not found.");
const failureScriptLines = [];
for (let index = failureScriptLine + 1; index < workflowLines.length; index += 1) {
  if (/^      - /.test(workflowLines[index])) break;
  failureScriptLines.push(workflowLines[index].replace(/^ {12}/, ""));
}
const failureScript = failureScriptLines.join("\n").trimEnd();
assert.ok(failureScript.length > 0, "The signing check failure script is empty.");

async function runNotification({
  issues = [],
  issuePages = [issues],
  runId,
  configured = false,
}) {
  const updates = [];
  const created = [];
  const allIssues = issuePages.flat();
  const context = {
    context: { repo: { owner: "test-owner", repo: "test-repo" } },
    process: {
      env: {
        WINDOWS_SIGNING_CHECK_OUTCOME: "success",
        WINDOWS_SIGNING_CONFIGURED: String(configured),
        WINDOWS_SIGNING_MISSING_SECRETS: configured
          ? ""
          : "WINDOWS_CERTIFICATE_BASE64,WINDOWS_CERTIFICATE_PASSWORD",
        WINDOWS_SIGNING_MAINTAINERS: "",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: runId,
      },
    },
    github: {
      paginate: async (endpoint, parameters) => {
        assert.equal(parameters.owner, "test-owner");
        assert.equal(parameters.repo, "test-repo");
        assert.equal(parameters.state, "all");
        const perPage = parameters.per_page ?? 100;
        const result = [];
        for (let page = 1; ; page += 1) {
          const pageIssues = await endpoint({ ...parameters, page });
          result.push(...pageIssues);
          if (pageIssues.length < perPage) return result;
        }
      },
      rest: {
        issues: {
          listForRepo: async ({ page = 1 }) => issuePages[page - 1] ?? [],
          update: async ({ issue_number, owner, repo, ...changes }) => {
            updates.push({ issue_number, ...changes });
            const issue = allIssues.find(
              (candidate) => candidate.number === issue_number,
            );
            Object.assign(issue, changes);
          },
          create: async (issue) => {
            created.push(issue);
          },
        },
      },
    },
    core: { info: () => {} },
  };

  await vm.runInNewContext(
    `(async () => {\n${notificationScript}\n})()`,
    context,
  );
  return { updates, created };
}

async function runFailureNotification({
  issues = [],
  issuePages = [issues],
  outcome = "failure",
  configured = true,
  hasCertificate = true,
  expiresAt = "2035-02-20",
  failureReason = "",
} = {}) {
  const updates = [];
  const created = [];
  const allIssues = issuePages.flat();
  const context = {
    context: { repo: { owner: "test-owner", repo: "test-repo" } },
    process: {
      env: {
        WINDOWS_SIGNING_CHECK_OUTCOME: outcome,
        WINDOWS_SIGNING_FAILURE_REASON: failureReason,
        WINDOWS_SIGNING_CONFIGURED: String(configured),
        WINDOWS_SIGNING_HAS_CERTIFICATE: String(hasCertificate),
        WINDOWS_SIGNING_EXPIRES_AT: expiresAt,
        WINDOWS_SIGNING_MAINTAINERS: "",
        WINDOWS_CERTIFICATE_BASE64: "certificate-secret-value",
        WINDOWS_CERTIFICATE_PASSWORD: "password-secret-value",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "failure-123",
      },
    },
    github: {
      paginate: async (endpoint, parameters) => {
        const result = [];
        for (let page = 1; ; page += 1) {
          const pageIssues = await endpoint({ ...parameters, page });
          result.push(...pageIssues);
          if (pageIssues.length < (parameters.per_page ?? 100)) return result;
        }
      },
      rest: {
        issues: {
          listForRepo: async ({ page = 1 }) => issuePages[page - 1] ?? [],
          update: async ({ issue_number, owner, repo, ...changes }) => {
            updates.push({ issue_number, ...changes });
            Object.assign(
              allIssues.find((issue) => issue.number === issue_number),
              changes,
            );
          },
          create: async (issue) => created.push(issue),
        },
      },
    },
  };
  await vm.runInNewContext(`(async () => {\n${failureScript}\n})()`, context);
  return { updates, created };
}

const existingAlert = {
  number: 10,
  title: "Windows signing is not configured",
  body: "Old alert body",
  state: "open",
};
const duplicateAlert = {
  number: 11,
  title: "Windows signing is not configured",
  body: "Duplicate alert body",
  state: "open",
};
const pullRequestWithMatchingTitle = {
  number: 12,
  title: "Windows signing is not configured",
  body: "Pull request body",
  state: "open",
  pull_request: {
    url: "https://api.github.com/repos/test-owner/test-repo/pulls/12",
  },
};
const issues = [existingAlert, duplicateAlert, pullRequestWithMatchingTitle];

const firstCheck = await runNotification({ issues, runId: "101" });
assert.equal(firstCheck.created.length, 0, "The first check created an alert.");
assert.deepEqual(
  firstCheck.updates.map(({ issue_number, state }) => ({
    issue_number,
    state,
  })),
  [
    { issue_number: 11, state: "closed" },
    { issue_number: 10, state: undefined },
  ],
  "The first check should close the duplicate and update the retained alert.",
);
assert.equal(existingAlert.state, "open");
assert.equal(duplicateAlert.state, "closed");
assert.equal(pullRequestWithMatchingTitle.state, "open");
assert.match(existingAlert.body, /WINDOWS_CERTIFICATE_BASE64/);
assert.match(existingAlert.body, /WINDOWS_CERTIFICATE_PASSWORD/);
assert.match(existingAlert.body, /actions\/runs\/101/);

const secondCheck = await runNotification({ issues, runId: "102" });
assert.equal(
  secondCheck.created.length,
  0,
  "The repeated check created an alert.",
);
assert.deepEqual(
  secondCheck.updates.map(({ issue_number, state }) => ({
    issue_number,
    state,
  })),
  [{ issue_number: 10, state: undefined }],
  "The repeated check should update only the retained alert.",
);
assert.equal(
  issues.filter(
    (issue) =>
      !issue.pull_request &&
      issue.title === "Windows signing is not configured" &&
      issue.state === "open",
  ).length,
  1,
  "Repeated checks should leave exactly one open signing alert.",
);
assert.match(existingAlert.body, /actions\/runs\/102/);

const configuredCheck = await runNotification({
  issues,
  runId: "103",
  configured: true,
});
assert.equal(
  configuredCheck.created.length,
  0,
  "The configured check created an alert.",
);
assert.deepEqual(
  configuredCheck.updates.map(({ issue_number, state }) => ({
    issue_number,
    state,
  })),
  [{ issue_number: 10, state: "closed" }],
  "The configured check should close the retained alert.",
);
assert.equal(existingAlert.state, "closed");

const recoveredMissingCheck = await runNotification({ issues, runId: "104" });
assert.equal(
  recoveredMissingCheck.created.length,
  0,
  "The missing-secret check created a new alert instead of reopening the existing one.",
);
assert.deepEqual(
  recoveredMissingCheck.updates.map(({ issue_number, state }) => ({
    issue_number,
    state,
  })),
  [{ issue_number: 10, state: "open" }],
  "The missing-secret check should reopen the same retained alert.",
);
assert.equal(existingAlert.state, "open");
assert.equal(duplicateAlert.state, "closed");
assert.match(existingAlert.body, /actions\/runs\/104/);
assert.equal(
  issues.filter(
    (issue) =>
      !issue.pull_request &&
      issue.title === "Windows signing is not configured" &&
      issue.state === "open",
  ).length,
  1,
  "Recovery should leave exactly one open signing alert.",
);

const healthyFirstCheck = await runNotification({
  issues: [],
  runId: "105",
  configured: true,
});
assert.deepEqual(healthyFirstCheck.created, [], "A healthy first check must stay silent.");

const failedCheck = await runFailureNotification();
assert.equal(failedCheck.created.length, 1);
assert.equal(
  failedCheck.created[0].title,
  "Windows signing certificate check failed",
);
assert.match(failedCheck.created[0].body, /could not read or validate/);
assert.match(failedCheck.created[0].body, /actions\/runs\/failure-123/);
assert.doesNotMatch(
  failedCheck.created[0].body,
  /certificate-secret-value|password-secret-value/i,
);

const failureIssue = {
  number: 30,
  title: "Windows signing certificate check failed",
  body: "Old failure",
  state: "open",
};
const recoveredCheck = await runFailureNotification({
  issues: [failureIssue],
  outcome: "success",
});
assert.deepEqual(recoveredCheck.updates, [
  { issue_number: 30, state: "closed" },
]);
assert.equal(failureIssue.state, "closed");

const recurringFailedCheck = await runFailureNotification({
  issues: [failureIssue],
  outcome: "failure",
});
assert.equal(recurringFailedCheck.created.length, 0);
assert.deepEqual(
  recurringFailedCheck.updates.map(({ issue_number, state }) => ({
    issue_number,
    state,
  })),
  [{ issue_number: failureIssue.number, state: "open" }],
);
assert.equal(failureIssue.state, "open");
assert.match(failureIssue.body, /actions\/runs\/failure-123/);

const invalidExpiry = await runFailureNotification({
  failureReason: "invalid-expiry",
  expiresAt: "not-a-date",
});
assert.equal(invalidExpiry.created.length, 1);
assert.match(invalidExpiry.created[0].body, /missing or invalid certificate expiry data/);

const laterPageFailureAlert = {
  number: 80,
  title: "Windows signing certificate check failed",
  body: "Old failure",
  state: "open",
};
const unrelatedPage = Array.from({ length: 100 }, (_, index) => ({
  number: index + 100,
  title: `Unrelated issue ${index + 1}`,
  state: "closed",
}));
const laterPageRecovery = await runFailureNotification({
  issuePages: [unrelatedPage, [laterPageFailureAlert]],
  outcome: "success",
});
assert.deepEqual(laterPageRecovery.updates, [
  { issue_number: 80, state: "closed" },
]);

console.log("Passed Windows signing configuration alert checks.");

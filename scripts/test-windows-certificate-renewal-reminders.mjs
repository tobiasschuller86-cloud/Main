import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workflow = await readFile(
  new URL("../.github/workflows/windows-installer.yml", import.meta.url),
  "utf8",
);
const workflowLines = workflow.split(/\r?\n/);
const renewalStep = workflowLines.findIndex(
  (line) => line.trim() === "- name: Notify maintainers about certificate renewal",
);
assert.notEqual(renewalStep, -1, "The certificate renewal notification step was not found.");
assert.match(
  workflowLines.slice(renewalStep, renewalStep + 3).join("\n"),
  /signing-configured == 'false'/,
  "A successfully detected missing configuration must retire stale renewal reminders.",
);
assert.match(
  workflowLines.slice(renewalStep, renewalStep + 3).join("\n"),
  /expiry-data-valid == 'true'/,
  "Renewal reminders must not use missing or invalid expiry data.",
);

const scriptLine = workflowLines.findIndex(
  (line, index) => index > renewalStep && /^ {10}script: \|$/.test(line),
);
assert.notEqual(scriptLine, -1, "The certificate renewal notification script was not found.");

const scriptLines = [];
for (let index = scriptLine + 1; index < workflowLines.length; index += 1) {
  if (/^      - /.test(workflowLines[index])) break;
  scriptLines.push(workflowLines[index].replace(/^ {12}/, ""));
}
const renewalScript = scriptLines.join("\n").trimEnd();
assert.ok(renewalScript.length > 0, "The certificate renewal notification script is empty.");

const expiryStep = workflowLines.findIndex(
  (line) =>
    line.trim() ===
    "- name: Notify maintainers when the Windows signing certificate has expired",
);
assert.notEqual(expiryStep, -1, "The certificate expiration notification step was not found.");
assert.match(
  workflowLines.slice(expiryStep, expiryStep + 3).join("\n"),
  /if: success\(\) &&/,
  "The expiration notification must be skipped when certificate validation fails.",
);
const expiryScriptLine = workflowLines.findIndex(
  (line, index) => index > expiryStep && /^ {10}script: \|$/.test(line),
);
assert.notEqual(expiryScriptLine, -1, "The certificate expiration notification script was not found.");
const expiryScriptLines = [];
for (let index = expiryScriptLine + 1; index < workflowLines.length; index += 1) {
  if (/^      - /.test(workflowLines[index]) || /^  [A-Za-z0-9_-]+:/.test(workflowLines[index])) break;
  expiryScriptLines.push(workflowLines[index].replace(/^ {12}/, ""));
}
const expiryScript = expiryScriptLines.join("\n").trimEnd();
assert.ok(expiryScript.length > 0, "The certificate expiration notification script is empty.");

async function runRenewalCheck({
  issues = [],
  issuePages = [issues],
  expiresAt,
  renewalNeeded,
  configured = true,
}) {
  const updates = [];
  const created = [];
  const messages = [];
  const pageRequests = [];
  const allIssues = issuePages.flat();
  const context = {
    context: { repo: { owner: "test-owner", repo: "test-repo" } },
    process: {
      env: {
        WINDOWS_SIGNING_EXPIRES_AT: expiresAt,
        WINDOWS_SIGNING_CONFIGURED: String(configured),
        WINDOWS_SIGNING_RENEWAL_NEEDED: String(renewalNeeded),
        WINDOWS_SIGNING_MAINTAINERS: "",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "123",
      },
    },
    github: {
      paginate: async (listIssues, options) => {
        const perPage = options.per_page ?? 100;
        const allPages = [];
        for (let page = 1; ; page += 1) {
          pageRequests.push(page);
          const pageIssues = await listIssues({ ...options, page });
          allPages.push(...pageIssues);
          if (pageIssues.length < perPage) break;
        }
        return allPages;
      },
      rest: {
        issues: {
          listForRepo: async ({ page = 1 }) => issuePages[page - 1] ?? [],
          update: async ({ issue_number, state, body }) => {
            updates.push({
              issue_number,
              ...(body === undefined ? {} : { body }),
              ...(state === undefined ? {} : { state }),
            });
            const issue = allIssues.find((candidate) => candidate.number === issue_number);
            if (state !== undefined) issue.state = state;
            if (body !== undefined) issue.body = body;
          },
          create: async (issue) => {
            created.push(issue);
          },
        },
      },
    },
    core: { info: (message) => messages.push(message) },
  };

  await vm.runInNewContext(`(async () => {\n${renewalScript}\n})()`, context);
  return { updates, created, messages, pageRequests };
}

const staleOpenReminder = {
  number: 10,
  title: "Windows signing certificate renewal: 2035-02-14 UTC",
  state: "open",
  pull_request: undefined,
};
const noLongerNeeded = await runRenewalCheck({
  issues: [staleOpenReminder],
  expiresAt: "2035-03-01",
  renewalNeeded: false,
});
assert.deepEqual(noLongerNeeded.updates, [{ issue_number: 10, state: "closed" }]);
assert.equal(noLongerNeeded.created.length, 0);
assert.equal(staleOpenReminder.state, "closed");

const missingConfigurationReminder = {
  number: 15,
  title: "Windows signing certificate renewal: 2035-02-14 UTC",
  state: "open",
  pull_request: undefined,
};
const missingConfiguration = await runRenewalCheck({
  issues: [missingConfigurationReminder],
  expiresAt: undefined,
  renewalNeeded: false,
  configured: false,
});
assert.deepEqual(missingConfiguration.updates, [
  { issue_number: 15, state: "closed" },
]);

const outdatedOpenReminder = {
  number: 20,
  title: "Windows signing certificate renewal: 2035-02-14 UTC",
  state: "open",
  pull_request: undefined,
};
const renewed = await runRenewalCheck({
  issues: [outdatedOpenReminder],
  expiresAt: "2035-02-20",
  renewalNeeded: true,
});
assert.deepEqual(renewed.updates, [{ issue_number: 20, state: "closed" }]);
assert.equal(outdatedOpenReminder.state, "closed");
assert.equal(renewed.created.length, 1);
assert.equal(
  renewed.created[0].title,
  "Windows signing certificate renewal: 2035-02-20 UTC",
);

const currentOpenReminder = {
  number: 30,
  title: "Windows signing certificate renewal: 2035-02-20 UTC",
  state: "open",
  pull_request: undefined,
};
const firstIssuePage = Array.from({ length: 100 }, (_, index) => ({
  number: index + 100,
  title: `Unrelated issue ${index + 1}`,
  state: "closed",
  pull_request: undefined,
}));
const matchingReminderExists = await runRenewalCheck({
  issuePages: [firstIssuePage, [currentOpenReminder]],
  expiresAt: "2035-02-20",
  renewalNeeded: true,
});
assert.equal(matchingReminderExists.created.length, 0);
assert.equal(matchingReminderExists.updates.length, 1);
assert.equal(matchingReminderExists.updates[0].issue_number, currentOpenReminder.number);
assert.match(matchingReminderExists.updates[0].body, /actions\/runs\/123/);
assert.deepEqual(
  matchingReminderExists.pageRequests,
  [1, 2],
  "The matching reminder on the second issue page must be found.",
);

const closedMatchingReminder = {
  number: 40,
  title: "Windows signing certificate renewal: 2035-02-20 UTC",
  state: "closed",
  pull_request: undefined,
};
const matchingReminderReopened = await runRenewalCheck({
  issues: [closedMatchingReminder],
  expiresAt: "2035-02-20",
  renewalNeeded: true,
});
assert.deepEqual(
  matchingReminderReopened.updates.map(({ issue_number, state }) => ({
    issue_number,
    state,
  })),
  [{ issue_number: 40, state: "open" }],
  "A closed reminder for the current expiry date must be reopened.",
);
assert.match(matchingReminderReopened.updates[0].body, /actions\/runs\/123/);
assert.equal(matchingReminderReopened.created.length, 0);
assert.equal(closedMatchingReminder.state, "open");

async function runExpiryCheck({
  issues = [],
  issuePages = [issues],
  expiresAt,
  expired = true,
}) {
  const created = [];
  const warnings = [];
  const updates = [];
  const allIssues = issuePages.flat();
  const context = {
    context: { repo: { owner: "test-owner", repo: "test-repo" } },
    process: {
      env: {
        WINDOWS_SIGNING_CONFIGURED: "true",
        WINDOWS_SIGNING_CERTIFICATE_EXPIRED: String(expired),
        WINDOWS_SIGNING_EXPIRES_AT: expiresAt,
        WINDOWS_SIGNING_MAINTAINERS: "",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "123",
      },
    },
    github: {
      paginate: async (endpoint, parameters) => {
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
          update: async ({ issue_number, state, body }) => {
            updates.push({
              issue_number,
              ...(body === undefined ? {} : { body }),
              ...(state === undefined ? {} : { state }),
            });
            const issue = allIssues.find((candidate) => candidate.number === issue_number);
            if (state !== undefined) issue.state = state;
            if (body !== undefined) issue.body = body;
          },
          create: async (issue) => created.push(issue),
        },
      },
    },
    core: { warning: (message) => warnings.push(message), info: () => {} },
  };

  await vm.runInNewContext(`(async () => {\n${expiryScript}\n})()`, context);
  return { created, warnings, updates };
}

for (const missingExpiry of [undefined, ""]) {
  const missingExpiryCheck = await runExpiryCheck({
    issues: [],
    expiresAt: missingExpiry,
  });
  assert.equal(
    missingExpiryCheck.created.length,
    0,
    "An expiration issue was created without an expiry date.",
  );
  assert.equal(missingExpiryCheck.warnings.length, 1);
}

for (const malformedExpiry of ["not-a-date", "2035-02-31"]) {
  const malformedExpiryCheck = await runExpiryCheck({
    issues: [],
    expiresAt: malformedExpiry,
  });
  assert.equal(
    malformedExpiryCheck.created.length,
    0,
    "An expiration issue was created with a malformed expiry date.",
  );
}

const expiredReminder = {
  number: 50,
  title: "Windows signing certificate expired: 2035-02-20 UTC",
  body: "Old expiration details",
  state: "closed",
};
const repeatedExpiration = await runExpiryCheck({
  issues: [expiredReminder],
  expiresAt: "2035-02-20",
});
assert.equal(repeatedExpiration.created.length, 0);
assert.equal(repeatedExpiration.updates.length, 1);
assert.equal(repeatedExpiration.updates[0].state, "open");
assert.match(repeatedExpiration.updates[0].body, /actions\/runs\/123/);
assert.equal(expiredReminder.state, "open");

const recoveredExpiration = await runExpiryCheck({
  issues: [expiredReminder],
  expiresAt: "2035-03-20",
  expired: false,
});
assert.deepEqual(recoveredExpiration.updates, [
  { issue_number: 50, state: "closed" },
]);
assert.equal(expiredReminder.state, "closed");

console.log("Passed Windows certificate renewal reminder checks.");

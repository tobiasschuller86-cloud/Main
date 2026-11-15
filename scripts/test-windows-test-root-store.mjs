import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("Windows test trust setup requires elevation and avoids CurrentUser Root", () => {
  const helper = read("windows-test-root-store.ps1");
  assert.match(helper, /WindowsBuiltInRole\]::Administrator/);
  assert.match(helper, /throw "Windows certificate tests require an elevated temporary test runner/);
  assert.match(helper, /StoreLocation\]::LocalMachine/);
  assert.ok(helper.indexOf("::Administrator") < helper.indexOf("$store.Open("));
});

test("all previously stalled tests use the shared test trust setup and retain cleanup", () => {
  for (const name of [
    "test-windows-signing-certificate.ps1",
    "test-partial-windows-packaging-cleanup.ps1",
    "test-signed-windows-packaging.ps1",
  ]) {
    const source = read(name);
    assert.match(source, /windows-test-root-store\.ps1/);
    assert.match(source, /= Open-WindowsTestRootStore/);
    assert.doesNotMatch(source, /X509Store\]::new\("Root", "CurrentUser"\)/);
    assert.match(source, /finally\s*\{/);
    assert.match(source, /(?:rootStore|trustStore)\.Remove\(/);
  }
});

test("production certificate validation does not load the test trust helper", () => {
  for (const name of ["windows-signing-certificate.ps1", "package-windows-builds.ps1"]) {
    assert.doesNotMatch(read(name), /windows-test-root-store|Open-WindowsTestRootStore/);
  }
  assert.match(read("windows-signing-certificate.ps1"), /\$chain\.Build\(\$signingCertificate\)/);
});

function assertWorkflowTimeouts(source) {
  const workflow = source.replace(/\r\n?/g, "\n");
  for (const [job, limit] of [
    ["test-certificate-expiry", 10],
    ["test-partial-packaging-cleanup", 10],
    ["test-signed-windows-packaging", 30],
  ]) {
    const body = workflow.split(`  ${job}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/)[0];
    assert.ok(body, `Missing ${job}`);
    assert.match(body, new RegExp(`timeout-minutes: ${limit}\\b`));
  }
}

test("certificate subprocess has bounded execution", () => {
  const certificateTest = read("test-windows-signing-certificate.ps1");
  assert.match(certificateTest, /ReadToEndAsync\(\)/);
  assert.match(certificateTest, /WaitForExit\(60000\)/);
  assert.match(certificateTest, /\.Kill\(\$true\)/);
});

for (const [name, ending] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`workflow safeguards accept ${name} and reject missing jobs or limits`, () => {
    const workflow = read("../.github/workflows/windows-installer.yml")
      .replace(/\r\n?/g, "\n").replace(/\n/g, ending);
    assertWorkflowTimeouts(workflow);
    assert.throws(() => assertWorkflowTimeouts(workflow.replace(
      "  test-certificate-expiry:", "  renamed-certificate-job:",
    )), /Missing test-certificate-expiry/);
    for (const limit of [10, 30]) {
      assert.throws(() => assertWorkflowTimeouts(workflow.replaceAll(
        `timeout-minutes: ${limit}`, "timeout-minutes: 99",
      )), /timeout-minutes/);
    }
  });
}

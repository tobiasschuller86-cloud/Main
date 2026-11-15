import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./windows-installer-smoke.mjs', import.meta.url), 'utf8');
const helper = source.slice(
  source.indexOf('async function verifyInitialOverview('),
  source.indexOf('async function verifyReleaseNotesLink('),
);

function page({ ready = 'complete', navigation = true, overview = true, action = true, text = 'TURNIERÜBERSICHT' } = {}) {
  return {
    readyState: ready,
    body: { innerText: text },
    querySelector(selector) {
      if (selector === '#main-navigation') return navigation ? {} : null;
      if (selector === 'main .page-heading .eyebrow') {
        return overview ? { textContent: 'Turnierübersicht' } : null;
      }
      if (selector === 'main [data-testid="button-edit-tournament"]') return action ? {} : null;
      throw new Error(`Unexpected overview selector: ${selector}`);
    },
  };
}

function harness(pages) {
  let clock = 0;
  let calls = 0;
  const context = vm.createContext({
    Date: { now: () => clock },
    delay: async (milliseconds) => { clock += milliseconds; },
    evaluatePage: async (_url, expression) => {
      const document = pages[Math.min(calls++, pages.length - 1)];
      return vm.runInNewContext(expression, { document });
    },
  });
  vm.runInContext(`${helper}\nglobalThis.check = verifyInitialOverview;`, context);
  return { check: () => context.check('synthetic-devtools-url'), calls: () => calls };
}

test('overview recognition ignores CSS uppercasing of rendered text', async () => {
  const check = harness([page()]);
  await check.check();
  assert.equal(check.calls(), 1);
});

test('overview recognition waits for the document and React page to finish loading', async () => {
  const check = harness([
    page({ ready: 'loading', navigation: false, overview: false, action: false }),
    page({ overview: false, action: false }),
    page(),
  ]);
  await check.check();
  assert.equal(check.calls(), 3);
});

for (const [label, options] of [
  ['missing overview page', { overview: false }],
  ['missing navigation', { navigation: false }],
  ['missing overview action', { action: false }],
  ['incomplete document', { ready: 'loading' }],
]) {
  test(`overview recognition still rejects ${label}`, async () => {
    const check = harness([page({ ...options, text: 'Turnierübersicht' })]);
    await assert.rejects(check.check(), /did not reach the overview screen within 15 seconds/);
    assert.equal(check.calls(), 60);
  });
}

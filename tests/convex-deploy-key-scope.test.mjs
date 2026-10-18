import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';

// The production Convex deploy key is a full-write credential for the billing,
// entitlement and account-deletion backend. Two properties keep it narrow:
//
// - Every job that reads it runs in the `convex-production` environment, whose
//   deployment branch policy admits only `main`. As a plain repository secret
//   it was readable by any workflow run on any branch, including a branch that
//   edits this file to run on itself.
// - No job that reads it runs dependency lifecycle scripts. An install script
//   runs before the deploy step and can rewrite `node_modules/.bin/convex`,
//   which then executes with the key in its environment.
const workflow = YAML.parse(
  readFileSync(new URL('../.github/workflows/convex-deploy.yml', import.meta.url), 'utf8'),
);
const KEY_REFERENCE = /\$\{\{\s*secrets\.CONVEX_DEPLOY_KEY\s*\}\}/;

const keyJobs = Object.entries(workflow.jobs).filter(([, job]) =>
  (job.steps ?? []).some((step) => Object.values(step.env ?? {}).some((value) => KEY_REFERENCE.test(String(value)))),
);

test('the deploy key is read only by the jobs that deploy or run production functions', () => {
  assert.deepEqual(keyJobs.map(([name]) => name).sort(), ['deploy', 'repair-stale-on-hold-derived-state']);
});

test('every job that reads the deploy key runs in the main-only convex-production environment', () => {
  for (const [name, job] of keyJobs) {
    const environment = typeof job.environment === 'string' ? { name: job.environment } : job.environment;
    assert.equal(environment?.name, 'convex-production', `${name} must declare environment convex-production`);
  }
});

test('no job that reads the deploy key runs dependency install scripts', () => {
  for (const [name, job] of keyJobs) {
    const installs = job.steps.filter((step) => /\bnpm (ci|install|i)\b/.test(step.run ?? ''));
    assert.ok(installs.length > 0, `${name} is expected to install dependencies`);
    for (const step of installs) {
      assert.match(step.run, /--ignore-scripts\b/, `${name}: "${step.run}" must pass --ignore-scripts`);
    }
  }
});

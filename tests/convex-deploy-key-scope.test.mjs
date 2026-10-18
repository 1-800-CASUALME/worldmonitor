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

function findKeyJobs(workflows) {
  return Object.entries(workflows)
    .filter(([file]) => file === 'convex-deploy.yml')
    .flatMap(([file, workflow]) => Object.entries(workflow.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) =>
        Object.values(step.env ?? {}).some((value) => KEY_REFERENCE.test(String(value)))))
      .map(([name, job]) => [`${file}:${name}`, job]));
}

const keyJobs = findKeyJobs({ 'convex-deploy.yml': workflow });

const key = '${{ secrets.CONVEX_DEPLOY_KEY }}';
for (const [name, file, fixture] of [
  ['step env', 'convex-deploy.yml', { jobs: { reader: { steps: [{ env: { KEY: key } }] } } }],
  ['job env', 'convex-deploy.yml', { jobs: { reader: { env: { KEY: key }, steps: [] } } }],
  ['workflow env', 'convex-deploy.yml', { env: { KEY: key }, jobs: { reader: { steps: [] } } }],
  ['action inputs', 'convex-deploy.yml', { jobs: { reader: { steps: [{ with: { key } }] } } }],
  ['run expressions', 'convex-deploy.yml', { jobs: { reader: { steps: [{ run: `echo ${key}` }] } } }],
  ['reusable workflow secrets', 'convex-deploy.yml', { jobs: { reader: { secrets: { key } } } }],
  ['compound expressions', 'convex-deploy.yml', { jobs: { reader: { env: { KEY: "${{ format('{0}', secrets.CONVEX_DEPLOY_KEY) }}" } } } }],
  ['bracket access', 'convex-deploy.yml', { jobs: { reader: { env: { KEY: '${{ secrets["convex_deploy_key"] }}' } } } }],
  ['another yml workflow', 'other.yml', { jobs: { reader: { steps: [{ env: { KEY: key } }] } } }],
  ['another yaml workflow', 'other.yaml', { jobs: { reader: { steps: [{ env: { KEY: key } }] } } }],
]) {
  test(`finds deploy-key readers in ${name}`, () => {
    assert.deepEqual(findKeyJobs({ [file]: fixture }).map(([id]) => id), [`${file}:reader`]);
  });
}

test('the deploy key is read only by the jobs that deploy or run production functions', () => {
  assert.deepEqual(keyJobs.map(([name]) => name).sort(), [
    'convex-deploy.yml:deploy',
    'convex-deploy.yml:repair-stale-on-hold-derived-state',
  ]);
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

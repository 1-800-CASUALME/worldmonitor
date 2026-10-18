// A retired tool leaves every published surface (tools/list, describe_tool,
// the server card, docs) but stays callable under its old name, so a client
// that hard-coded it keeps working. generate_forecasts was retired because it
// read the same published list as get_forecast_predictions while its name
// claimed it started a forecast run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETIRED_TOOLS, TOOL_LIST_RESPONSE, TOOL_REGISTRY, findCallableTool } from '../api/mcp/registry/index.ts';

const RETIRED = ['generate_forecasts'];

describe('retired MCP tools', () => {
  it('lists exactly the retired names, none of them registered', () => {
    assert.deepEqual(RETIRED_TOOLS.map(tool => tool.name), RETIRED);
    const registered = new Set(TOOL_REGISTRY.map(tool => tool.name));
    for (const name of RETIRED) assert.equal(registered.has(name), false, `${name} must not be in TOOL_REGISTRY`);
  });

  it('keeps retired tools out of tools/list', () => {
    const listed = new Set(TOOL_LIST_RESPONSE.map(tool => tool.name));
    for (const name of RETIRED) assert.equal(listed.has(name), false, `${name} must not be listed`);
  });

  it('still resolves a retired name for tools/call', () => {
    for (const name of RETIRED) assert.equal(findCallableTool(name)?.name, name);
    assert.equal(findCallableTool('get_forecast_predictions')?.name, 'get_forecast_predictions');
    assert.equal(findCallableTool('no_such_tool'), undefined);
  });

  it('keeps retired tools off the server card', () => {
    const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
    const names = new Set(card.tools.map(tool => tool.name));
    for (const name of RETIRED) assert.equal(names.has(name), false, `${name} must not be on the server card`);
  });
});

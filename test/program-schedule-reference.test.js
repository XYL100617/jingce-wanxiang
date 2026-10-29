'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../server/data/scenic_graph.json');
const reference = require('../server/data/program-schedule-reference.json');

test('schedule reference contains at least ten exact Map1 event venue mappings and remains non-operational', () => {
  const nodes = new Map(graph.nodes.map(node => [node.node_id, node]));
  assert.equal(reference.source.schedule_date, null);
  assert.equal(reference.programs.length >= 10, true);
  assert.equal(new Set(reference.programs.map(program => program.program_id)).size, reference.programs.length);
  for (const program of reference.programs) {
    const node = nodes.get(program.node_id);
    assert.ok(node, `${program.program_id} must reference an existing Map1 node`);
    assert.equal(node.name, program.venue_name, `${program.program_id} venue must match Map1 exactly`);
    assert.equal(node.poi_id, program.poi_id, `${program.program_id} POI ID must match Map1`);
    assert.equal(program.map1_name_match, 'EXACT');
    assert.equal(program.status, 'REFERENCE_ONLY');
    assert.equal(program.real_schedule_eligible, false);
    assert.ok(program.sources.length > 0);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const graph = require('../server/data/scenic_graph.json');
const { routeSeeds } = require('../server/dna-seeds');
const { ROUTE_TAGS } = require('../server/community');

test('all DNA sample stop chains use Map 1 POIs and each consecutive pair has a direct Map 1 edge', () => {
  const poiIds = new Set(graph.nodes.filter(node => node.poi_id).map(node => node.poi_id));
  const edges = new Set(graph.edges.flatMap(edge => [`${edge.from_node_id}>${edge.to_node_id}`, `${edge.to_node_id}>${edge.from_node_id}`]));
  const routeIds = new Set();
  for (const route of routeSeeds) {
    assert.equal(routeIds.has(route.id), false, `duplicate DNA id ${route.id}`);
    routeIds.add(route.id);
    assert.ok(route.stops.length >= 3, `${route.id} needs enough stops to be a route`);
    for (const stop of route.stops) assert.ok(poiIds.has(stop), `${route.id} references a non-POI or unknown Map 1 node: ${stop}`);
    for (let index = 1; index < route.stops.length; index += 1)
      assert.ok(edges.has(`${route.stops[index - 1]}>${route.stops[index]}`), `${route.id} has a disconnected sequence at ${route.stops[index - 1]} -> ${route.stops[index]}`);
  }
  assert.ok(routeSeeds.filter(route => route.minutes >= 240).length >= 4, 'include several long-form DNA routes');
  assert.ok(routeSeeds.length >= 8, 'the DNA gallery should include more than the original three sample routes');
  assert.ok(['亲水', '街巷', '长线'].every(tag => ROUTE_TAGS.includes(tag) && routeSeeds.some(route => route.tags.includes(tag))), 'additional filters must be used by routes and accepted by the sharing contract');
  assert.ok(['多景点', '水岸风光', '街区漫游'].every(tag => ROUTE_TAGS.includes(tag) && routeSeeds.some(route => route.tags.includes(tag))), 'new traits must be filterable and represented by sample routes');
  assert.ok(routeSeeds.every(route => route.tags.length <= 5 && route.tags.every(tag => ROUTE_TAGS.includes(tag))), 'sample routes must respect the same five-tag community contract');
});

test('DNA gallery combines route sources and applies selected tags before rendering results', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /new Map\(\[\.\.\.\(data\.seeds \|\| \[\]\), \.\.\.bundledSeeds\]/, 'merge API and bundled routes by ID so a short API response does not hide templates');
  assert.match(app, /selected\.every\(tag => \(tags \|\| \[\]\)\.includes\(tag\)\)/, 'all selected characteristics must constrain the visible routes');
  assert.match(app, /找到 \$\{seeds\.length \+ shared\.length\} 条/, 'show how many routes match the active filters');
  assert.match(app, /dnaEmptyClear/, 'offer a clear-filter action when no route matches');
  assert.match(app, /ROUTE_TAGS_CLIENT\.map\(tag => `<label><input type="checkbox" value="\$\{escapeHtml\(tag\)\}"/, 'the DNA sharing form must render the same characteristic choices as the filters');
  assert.match(app, /路线特点最多选择 5 项/, 'the sharing form must enforce the server five-tag limit before submission');
  assert.match(app, /已选 \$\{count\}\/5/, 'the sharing form must show the selected-tag count');
});

test('DNA desktop gallery uses equal-height panels with an independently scrolling result list', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.css'), 'utf8');
  assert.match(css, /\.dna-list\{height:clamp\([^}]*overflow-y:auto/, 'the route column should have a bounded height and its own vertical scroll');
  assert.match(css, /\.dna-filters\{position:sticky[^}]*height:clamp\(/, 'the filter column should align with the scroll panel height');
  assert.match(css, /@media\(max-width:1050px\)\{\.dna-layout\{grid-template-columns:1fr\}/, 'the layout should collapse cleanly on narrower screens');
});

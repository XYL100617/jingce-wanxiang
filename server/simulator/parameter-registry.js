'use strict';

const { PARAMETERS, VERSION } = require('./config/default-parameters');
const { PARAMETERS: OBSERVATION_PARAMETERS, VERSION: OBSERVATION_VERSION } = require('./config/observation-parameters');
const SCENARIOS = require('./config/scenarios');

function resolveScenario(scenario = 'P0_BASELINE') {
  const selected = SCENARIOS[scenario];
  if (!selected) throw new RangeError(`unknown P0 scenario: ${scenario}`);
  return selected;
}

function resolveParameters(scenario, rng) {
  if (!rng || typeof rng.uniform !== 'function') throw new TypeError('seeded RNG is required');
  const values = {};
  for (const [name, definition] of Object.entries(PARAMETERS)) {
    values[name] = definition.range ? rng.uniform(...definition.range) : definition.value;
  }
  for (const [name, reference] of Object.entries(scenario.parameter_overrides)) {
    if (!(name in values) || !(reference in values)) throw new Error(`unknown parameter override: ${name}=${reference}`);
    values[name] = values[reference];
  }
  return Object.freeze(values);
}

function resolveObservationParameters() {
  return Object.freeze(Object.fromEntries(Object.entries(OBSERVATION_PARAMETERS)
    .map(([name, definition]) => [name, definition.value])));
}

module.exports = { PARAMETERS, VERSION, resolveScenario, resolveParameters,
  OBSERVATION_PARAMETERS, OBSERVATION_VERSION, resolveObservationParameters };

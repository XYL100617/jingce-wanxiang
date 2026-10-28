'use strict';

const { SeededRNG } = require('./seeded-rng');
const D = require('./config/scenario-distributions');

const round = n => Math.round(n * 1e6) / 1e6;
const definition = (name, distribution_type, bounds) => ({ parameter_name: name,
  distribution_type, ...(distribution_type === 'DISCRETE_CHOICE'
    ? { choices: [...bounds] } : { min: bounds[0], max: bounds[1] }),
  source_tier: 'T4', basis: 'ASSUMPTION', version: D.VERSION });

function scenarioId(family, seed, index, dimensions) {
  if (typeof family !== 'string' || !/^[A-Za-z0-9_-]+$/.test(family)) {
    throw new RangeError('invalid scenario family');
  }
  const signature = Object.keys(D.DIMENSIONS).map(name => `${name}=${dimensions?.[name]}`).join('|');
  let hash = 0x811c9dc5;
  for (const char of signature) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `scn_${family}_seed${seed}_${String(index).padStart(6, '0')}_${hash.toString(16).padStart(8, '0')}`;
}

function sampleScenario({ scenario_family = 'DR_BASE', seed = 42, index = 1,
  dimensions = {} } = {}) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('invalid scenario index');
  new SeededRNG(seed); // Validate the public seed before combining substreams.
  const rng = new SeededRNG((seed ^ Math.imul(index + 1, 0x9e3779b9) ^ 0x6a09e667) >>> 0);
  const selected = {};
  for (const [name, choices] of Object.entries(D.DIMENSIONS)) {
    const value = dimensions[name] ?? rng.choice(choices);
    if (!choices.includes(value)) throw new RangeError(`invalid scenario dimension ${name}: ${value}`);
    selected[name] = value;
  }
  if (Object.keys(dimensions).some(name => !Object.hasOwn(D.DIMENSIONS, name))) {
    throw new RangeError('unknown scenario dimension');
  }
  const crowd = D.CROWD_ARRIVAL[selected.crowd_level];
  const calendar = D.CALENDAR_SCALE[selected.calendar_type];
  const crowd_arrival_scale = round(rng.uniform(...crowd));
  const calendar_scale = round(rng.uniform(...calendar));
  const quality = selected.observation_quality;
  const noisy = quality === 'NOISY' || quality === 'MIXED';
  const missing = quality === 'MISSING' || quality === 'MIXED';
  const delayed = quality === 'DELAYED' || quality === 'MIXED';
  const sampled_parameters = {
    crowd_arrival_scale, calendar_scale,
    arrival_scale: round(crowd_arrival_scale * calendar_scale),
    walking_speed_factor_range: [...D.SPEED_RANGES[selected.visitor_speed_distribution]],
    dwell_time_factor_range: [...D.DWELL_RANGES[selected.dwell_distribution]],
    road_closure_start_min: rng.choice(D.ROAD_START_MIN),
    road_closure_duration_min: rng.choice(D.ROAD_DURATION_MIN),
    event_delay_min: selected.event_condition === 'EVENT_DELAY' ? rng.choice(D.EVENT_DELAY_MIN) : 0,
    observation_noise_scale: noisy ? round(rng.uniform(...D.NOISE_SCALE)) : 0,
    observation_missing_scale: missing ? round(rng.uniform(...D.MISSING_SCALE)) : 0,
    observation_delay_min: delayed ? rng.choice(D.OBSERVATION_DELAY_MIN) : 0,
    position_confidence: noisy ? round(rng.uniform(...D.POSITION_CONFIDENCE)) : 1,
    ...Object.fromEntries(Object.entries(D.CAPACITY_SERVICE_SCALE)
      .map(([name, bounds]) => [name, round(rng.uniform(...bounds))]))
  };
  const parameter_provenance = {
    crowd_arrival_scale: definition('crowd_arrival_scale', 'UNIFORM', crowd),
    calendar_scale: definition('calendar_scale', 'UNIFORM', calendar),
    arrival_scale: definition('arrival_scale', 'BOUNDED_PRODUCT',
      [crowd[0] * calendar[0], crowd[1] * calendar[1]]),
    walking_speed_factor_range: definition('walking_speed_factor_range', 'BOUNDED_RANGE',
      D.SPEED_RANGES[selected.visitor_speed_distribution]),
    dwell_time_factor_range: definition('dwell_time_factor_range', 'BOUNDED_RANGE',
      D.DWELL_RANGES[selected.dwell_distribution]),
    road_closure_start_min: definition('road_closure_start_min', 'DISCRETE_CHOICE', D.ROAD_START_MIN),
    road_closure_duration_min: definition('road_closure_duration_min', 'DISCRETE_CHOICE', D.ROAD_DURATION_MIN),
    event_delay_min: definition('event_delay_min', 'DISCRETE_CHOICE', [0, ...D.EVENT_DELAY_MIN]),
    observation_noise_scale: definition('observation_noise_scale', 'UNIFORM', [0, D.NOISE_SCALE[1]]),
    observation_missing_scale: definition('observation_missing_scale', 'UNIFORM', [0, D.MISSING_SCALE[1]]),
    observation_delay_min: definition('observation_delay_min', 'DISCRETE_CHOICE', [0, ...D.OBSERVATION_DELAY_MIN]),
    position_confidence: definition('position_confidence', 'UNIFORM', [D.POSITION_CONFIDENCE[0], 1]),
    ...Object.fromEntries(Object.entries(D.CAPACITY_SERVICE_SCALE)
      .map(([name, bounds]) => [name, definition(name, 'UNIFORM', bounds)]))
  };
  const instance = { scenario_instance_id: scenarioId(scenario_family, seed, index, selected),
    scenario_family, seed, index, scenario_parameter_version: D.VERSION,
    dimensions: selected, sampled_parameters,
    provenance: { source_tier: 'T4', synthetic: true, basis: 'ASSUMPTION',
      version: D.VERSION, parameters: parameter_provenance } };
  validateScenarioInstance(instance);
  return instance;
}

function validateScenarioInstance(instance) {
  if (!Number.isInteger(instance?.seed) || instance.seed < 0 || instance.seed > 0xffffffff) {
    throw new RangeError('invalid scenario seed');
  }
  if (!instance || !Number.isInteger(instance.index) || instance.index < 0
    || instance.scenario_instance_id !== scenarioId(instance.scenario_family, instance.seed,
      instance.index, instance.dimensions)
    || instance.scenario_parameter_version !== D.VERSION
    || instance.provenance?.source_tier !== 'T4' || instance.provenance.synthetic !== true
    || instance.provenance.basis !== 'ASSUMPTION' || instance.provenance.version !== D.VERSION) {
    throw new TypeError('invalid T4 scenario instance');
  }
  for (const [name, choices] of Object.entries(D.DIMENSIONS)) {
    if (!choices.includes(instance.dimensions?.[name])) throw new RangeError(`invalid ${name}`);
  }
  const params = instance.sampled_parameters;
  if (!params || Object.keys(params).length !== 17
    || Object.keys(instance.provenance.parameters || {}).length !== 17) {
    throw new TypeError('incomplete scenario parameters or provenance');
  }
  for (const [name, value] of Object.entries(params)) {
    const meta = instance.provenance.parameters[name];
    if (!meta || meta.parameter_name !== name || meta.source_tier !== 'T4'
      || meta.basis !== 'ASSUMPTION' || meta.version !== D.VERSION) {
      throw new TypeError(`invalid ${name} provenance`);
    }
    if (Array.isArray(value)) {
      if (value.length !== 2 || !value.every(Number.isFinite)
        || value[0] <= 0 || value[1] < value[0]
        || value[0] < meta.min || value[1] > meta.max) throw new RangeError(`invalid ${name}`);
    } else if (!Number.isFinite(value) || (meta.choices && !meta.choices.includes(value))
      || (!meta.choices && (value < meta.min - 0.000001 || value > meta.max + 0.000001))) {
      throw new RangeError(`invalid ${name}`);
    }
  }
  const d = instance.dimensions;
  const inRange = (value, bounds) => value >= bounds[0] - 0.000001
    && value <= bounds[1] + 0.000001;
  const exactRange = (value, bounds) => Array.isArray(value) && value[0] === bounds[0]
    && value[1] === bounds[1];
  const quality = d.observation_quality;
  const noisy = quality === 'NOISY' || quality === 'MIXED';
  const missing = quality === 'MISSING' || quality === 'MIXED';
  const delayed = quality === 'DELAYED' || quality === 'MIXED';
  if (!inRange(params.crowd_arrival_scale, D.CROWD_ARRIVAL[d.crowd_level])
    || !inRange(params.calendar_scale, D.CALENDAR_SCALE[d.calendar_type])
    || !exactRange(params.walking_speed_factor_range, D.SPEED_RANGES[d.visitor_speed_distribution])
    || !exactRange(params.dwell_time_factor_range, D.DWELL_RANGES[d.dwell_distribution])
    || !D.ROAD_START_MIN.includes(params.road_closure_start_min)
    || !D.ROAD_DURATION_MIN.includes(params.road_closure_duration_min)
    || (noisy ? !inRange(params.observation_noise_scale, D.NOISE_SCALE)
      : params.observation_noise_scale !== 0)
    || (missing ? !inRange(params.observation_missing_scale, D.MISSING_SCALE)
      : params.observation_missing_scale !== 0)
    || (delayed ? !D.OBSERVATION_DELAY_MIN.includes(params.observation_delay_min)
      : params.observation_delay_min !== 0)
    || (!noisy ? params.position_confidence !== 1
      : !inRange(params.position_confidence, D.POSITION_CONFIDENCE))
    || Object.entries(D.CAPACITY_SERVICE_SCALE).some(([name, bounds]) =>
      !inRange(params[name], bounds))
    || (d.event_condition === 'EVENT_DELAY' && !D.EVENT_DELAY_MIN.includes(params.event_delay_min))) {
    throw new RangeError('scenario parameters outside canonical T4 bounds');
  }
  if (Math.abs(params.arrival_scale - params.crowd_arrival_scale * params.calendar_scale) > 0.000002
    || params.arrival_scale <= 0 || params.position_confidence > 1
    || (instance.dimensions.event_condition === 'NORMAL_EVENT' && params.event_delay_min !== 0)
    || (instance.dimensions.event_condition === 'EVENT_DELAY' && params.event_delay_min <= 0)) {
    throw new RangeError('inconsistent scenario parameters');
  }
  return instance;
}

module.exports = { sampleScenario, validateScenarioInstance, scenarioId };

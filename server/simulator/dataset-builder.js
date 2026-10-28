'use strict';

const provider = require('../state/stateProvider');
const { createSimulator } = require('./simulator');
const { sampleScenario, validateScenarioInstance } = require('./scenario-sampler');
const { createVisitorProfile, validateVisitorProfile } = require('./visitor-profile');
const { createEpisode, captureDecisionInput, appendTransition,
  finalizeEpisode } = require('./episode-writer');
const { selectRolloutAction } = require('./rollout-policy');
const { DATASET_SCHEMA_VERSION, HORIZONS, projectEnvironment, occupancyAudit,
  validateDecisionDataset, validateEnvironmentRollout } = require('./dataset-contract');

const clone = value => JSON.parse(JSON.stringify(value));
const ACTION_TYPES = ['VISIT_POI', 'ATTEND_EVENT', 'REST', 'WAIT', 'EXIT'];

function validateBatch(scenarioInstances, seeds, episodesPerScenario = 1) {
  if (!Array.isArray(scenarioInstances) || !scenarioInstances.length || scenarioInstances.length > 5
    || !Array.isArray(seeds) || !seeds.length || seeds.length > 3
    || !Number.isInteger(episodesPerScenario) || episodesPerScenario < 1
    || episodesPerScenario > 4 || scenarioInstances.length * seeds.length * episodesPerScenario > 60) {
    throw new RangeError('builder accepts only a small review batch');
  }
  scenarioInstances.forEach(validateScenarioInstance);
}

function scenarioForSeed(base, seed) {
  return seed === base.seed ? clone(base) : sampleScenario({
    scenario_family: base.scenario_family, seed, index: base.index,
    dimensions: base.dimensions });
}

function datasetMetadata(sim, episodeId = null, stepIndex = null, profile = null) {
  const m = sim.getMetadata();
  const scenario = sim.getScenarioInstance();
  return { episode_id: episodeId, step_index: stepIndex,
    scenario_instance_id: m.scenario_instance_id, seed: m.seed,
    scenario_dimensions: scenario?.dimensions ?? null,
    closure_edge_id: m.closure_edge_id,
    graph_version: m.graph_version, simulator_version: m.simulator_version,
    parameter_version: m.parameter_version, scenario_parameter_version: m.scenario_parameter_version,
    observation_version: m.observation_version, reward_version: m.reward_version,
    episode_schema_version: 'episode-p1.1', visitor_profile_version: m.visitor_profile_version,
    visitor_profile_id: profile?.profile_id ?? null,
    visitor_profile: profile ? {
      walking_speed_factor: profile.walking_speed_factor,
      dwell_time_factor: profile.dwell_time_factor,
      preference_weights: clone(profile.preference_weights),
      early_exit_base: profile.early_exit_base,
      profile_version: profile.profile_version,
      source_tier: profile.source_tier,
      parameter_basis: profile.parameter_basis } : null,
    source_tier: 'T4', synthetic: true };
}

function generateDecisionDataset({ scenarioInstances, visitorProfiles = [{}], seeds = [42],
  episodes_per_scenario = 1, max_decisions = 5, max_internal_steps = 80 } = {}) {
  validateBatch(scenarioInstances, seeds, episodes_per_scenario);
  if (!Array.isArray(visitorProfiles) || !visitorProfiles.length || visitorProfiles.length > 3
    || !Number.isInteger(max_decisions) || max_decisions < 1 || max_decisions > 8
    || !Number.isInteger(max_internal_steps) || max_internal_steps < 1 || max_internal_steps > 100) {
    throw new RangeError('invalid small decision batch limits');
  }
  const samples = [], episode_summaries = [];
  const stats = { action_counts: Object.fromEntries(ACTION_TYPES.map(type => [type, 0])),
    plan_accepted: 0, deviation_occurred: 0, early_exit_occurred: 0,
    reward_min: null, reward_max: null };
  for (const base of scenarioInstances) for (const seed of seeds) {
    const instance = scenarioForSeed(base, seed);
    for (let run = 0; run < episodes_per_scenario; run += 1) {
      const spec = visitorProfiles[run % visitorProfiles.length];
      const initialState = provider.getState();
      if (spec.initial_fatigue !== undefined) {
        if (!Number.isFinite(spec.initial_fatigue)
          || spec.initial_fatigue < 0 || spec.initial_fatigue > 1) {
          throw new RangeError('initial_fatigue must be within 0..1');
        }
        initialState.visitor.fatigue = spec.initial_fatigue;
      }
      const overrides = spec.overrides || Object.fromEntries(Object.entries(spec)
        .filter(([key]) => key !== 'initial_fatigue'));
      const profile = spec.profile_version ? clone(validateVisitorProfile(spec))
        : createVisitorProfile({ seed, profileIndex: run + 1, scenarioInstance: instance,
          overrides });
      const sim = createSimulator({ seed, scenarioInstance: instance, visitorProfile: profile,
        initialState });
      const episode = createEpisode(sim, { runIndex: run + 1 });
      const nodeTypes = Object.fromEntries(sim.getGraph().nodes.map(node => [node.node_id, node.type]));
      for (let decisionIndex = 0; decisionIndex < max_decisions && !episode.done; decisionIndex += 1) {
        const input = captureDecisionInput(sim);
        const recommended = (input.visitor_state.fatigue >= 0.65
          ? input.legal_actions.find(item => item.action.action_type === 'REST') : null)
          || (decisionIndex % 3 === 1
            ? input.legal_actions.find(item => item.action.action_type === 'ATTEND_EVENT') : null)
          || input.legal_actions.find(item =>
          !['EXIT', 'WAIT'].includes(item.action.action_type))
          || input.legal_actions.find(item => item.action.action_type === 'WAIT')
          || input.legal_actions.find(item => item.action.action_type === 'EXIT'
            && item.action.target_node_id !== input.visitor_state.current_node_id)
          || input.legal_actions[0];
        if (!recommended) throw new Error('no legal decision action');
        const selection = selectRolloutAction({ legalActions: input.legal_actions,
          recommendedAction: recommended.action, observation: input.observation,
          visitorState: input.visitor_state, profile, nodeTypes, seed, decisionIndex,
          forceExit: decisionIndex === max_decisions - 1 });
        sim.startDecisionTransition(selection.chosen_action);
        let terminal = null, terminal_step_timestamp = null, terminal_step = null;
        for (let internal = 0; internal < max_internal_steps; internal += 1) {
          const step = sim.step();
          if (step.decision_transition && step.decision_transition.audit.status !== 'IN_PROGRESS') {
            terminal = step.decision_transition;
            terminal_step_timestamp = step.timestamp;
            terminal_step = step;
            break;
          }
        }
        if (!terminal) throw new Error('decision transition exceeded small-batch step limit');
        const row = appendTransition(episode, { input, chosen_action: selection.chosen_action,
          terminal, terminal_step_timestamp, simulator: sim });
        const metadata = datasetMetadata(sim, episode.episode_id, row.step_index, profile);
        samples.push({ input: { observation: row.observation, visitor_state: row.visitor_state,
          legal_actions: row.legal_actions, chosen_action: row.chosen_action,
          delta_t_min: row.delta_t_min },
        target: { reward: row.reward, next_observation: row.next_observation,
          next_visitor_state: row.next_visitor_state, latent_target: row.latent_target,
          done: row.done, termination_reason: row.termination_reason },
        audit: { transition_audit: row.transition_audit,
          policy_audit: selection.policy_audit,
          invariant_summary: terminal_step.invariant_summary }, metadata });
        stats.action_counts[row.chosen_action.action_type] += 1;
        if (selection.policy_audit.plan_accepted) stats.plan_accepted += 1;
        if (selection.policy_audit.deviation_occurred) stats.deviation_occurred += 1;
        if (selection.policy_audit.early_exit_occurred) stats.early_exit_occurred += 1;
        stats.reward_min = stats.reward_min === null ? row.reward.total
          : Math.min(stats.reward_min, row.reward.total);
        stats.reward_max = stats.reward_max === null ? row.reward.total
          : Math.max(stats.reward_max, row.reward.total);
      }
      const finished = finalizeEpisode(episode);
      episode_summaries.push({ episode_id: finished.episode_id,
        scenario_instance_id: instance.scenario_instance_id, seed,
        started_at: finished.started_at, ended_at: finished.ended_at,
        duration_min: (Date.parse(finished.ended_at) - Date.parse(finished.started_at)) / 60000,
        poi_completed: finished.steps.filter(step => step.chosen_action.action_type === 'VISIT_POI'
          && step.transition_audit.outcome === 'COMPLETED').length,
        event_completed: finished.steps.filter(step => step.chosen_action.action_type === 'ATTEND_EVENT'
          && step.transition_audit.outcome === 'COMPLETED').length,
        early_exit: samples.some(sample => sample.metadata.episode_id === finished.episode_id
          && sample.audit.policy_audit.early_exit_occurred),
        step_count: finished.steps.length, done: finished.done,
        termination_reason: finished.termination_reason });
    }
  }
  const dataset = { dataset_type: 'DECISION_TRANSITION', schema_version: DATASET_SCHEMA_VERSION,
    source_tier: 'T4', synthetic: true, samples, episode_summaries,
    stats: { ...stats, episode_count: episode_summaries.length, sample_count: samples.length } };
  validateDecisionDataset(dataset);
  return dataset;
}

function generateEnvironmentRollout({ scenarioInstances, seeds = [42], steps = 24 } = {}) {
  validateBatch(scenarioInstances, seeds);
  if (!Number.isInteger(steps) || steps < 12 || steps > 36) {
    throw new RangeError('rollout steps must cover 60 min and stay small');
  }
  const samples = [], trajectory_summaries = [];
  for (const base of scenarioInstances) for (const seed of seeds) {
    const instance = scenarioForSeed(base, seed);
    const sim = createSimulator({ seed, scenarioInstance: instance });
    const capture = () => {
      const state = sim.getState();
      return { environment: projectEnvironment(state), observation: sim.getObservation(),
        expected_edge_occupancy: occupancyAudit(state) };
    };
    const frames = [capture()];
    for (let i = 0; i < steps; i += 1) {
      const result = sim.step();
      if (result.invariant_summary.population !== 'PASS'
        || result.invariant_summary.road_occupancy !== 'PASS') {
        throw new Error('simulator conservation failed during rollout');
      }
      frames.push(capture());
    }
    const trajectory_id = `env_${instance.scenario_instance_id}`;
    const closureEdge = sim.getScenarioInstance().closure_edge_id ?? null;
    trajectory_summaries.push({ trajectory_id,
      scenario_instance_id: instance.scenario_instance_id, seed,
      crowd_level: instance.dimensions.crowd_level,
      weather: instance.dimensions.weather,
      arrival_scale: instance.sampled_parameters.arrival_scale,
      arrivals_total: frames.at(-1).environment.population.arrivals_total,
      closure_edge_id: closureEdge,
      closure_observed: closureEdge ? frames.some(frame =>
        frame.environment.roads[closureEdge].is_open === false) : false,
      initial_road_time_min: frames[0].environment.roads[Object.keys(frames[0].environment.roads)[0]].travel_time_min });
    for (let index = 0; index < steps; index += 1) {
      const targets = {}, target_available = {};
      for (const [key, offset] of Object.entries(HORIZONS)) {
        const frame = frames[index + offset];
        targets[key] = frame ? { step_index: index + offset,
          environment: clone(frame.environment) } : null;
        target_available[key] = !!frame;
      }
      samples.push({ observed_input: { observation: clone(frames[index].observation) },
        latent_current: { environment_state: clone(frames[index].environment) },
        future_target: targets, target_available,
      audit: { expected_edge_occupancy: clone(frames[index].expected_edge_occupancy) },
      metadata: { ...datasetMetadata(sim), trajectory_id, step_index: index } });
    }
  }
  const validTargets = Object.fromEntries(Object.keys(HORIZONS).map(key =>
    [key, samples.filter(sample => sample.target_available[key]).length]));
  const dataset = { dataset_type: 'FIXED_5_MIN_ENVIRONMENT',
    schema_version: DATASET_SCHEMA_VERSION, step_min: 5,
    source_tier: 'T4', synthetic: true, samples, trajectory_summaries,
    stats: { sample_count: samples.length, valid_targets: validTargets } };
  validateEnvironmentRollout(dataset);
  return dataset;
}

module.exports = { generateDecisionDataset, generateEnvironmentRollout };

'use strict';

const FACTORS = ['time', 'interest', 'comfort', 'freedom', 'culture', 'nature', 'performance', 'food'];
const LABELS = {
  time: '时间效率', interest: '综合兴趣', comfort: '舒适负荷', freedom: '自由探索',
  culture: '历史文化', nature: '自然景观', performance: '演艺活动', food: '美食市集'
};

const ARCHETYPE_PRIORS = {
  fast: { time: 1.15, interest: .25, comfort: -.15, freedom: -.45 },
  normal: { interest: .35, comfort: .25, culture: .15, nature: .15 },
  free: { freedom: 1.05, interest: .35, nature: .25, time: -.35 }
};

const SCALE_MATRIX = {
  queue_tolerance: { time: -.55, comfort: -.7, interest: .35, performance: .25 },
  walking_tolerance: { time: -.2, comfort: -.65, freedom: .45, nature: .45 },
  schedule_preference: { time: .55, freedom: -.7, performance: .45 },
  depth_preference: { time: -.45, interest: .4, culture: .55 },
  crowd_sensitivity: { comfort: .7, time: .25, performance: -.25, freedom: .15 },
  novelty_preference: { freedom: .55, interest: .45, culture: -.1 },
  rest_need: { comfort: .85, time: -.35 },
  photo_preference: { interest: .35, nature: .45, freedom: .25 }
};

const INTEREST_FACTORS = {
  culture: { culture: .9, interest: .25 },
  nature: { nature: .9, interest: .25 },
  performance: { performance: .9, interest: .25 },
  food: { food: .9, freedom: .15 },
  photo: { nature: .4, freedom: .35, interest: .25 },
  interactive: { performance: .35, freedom: .4, interest: .3 }
};

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function addVector(target, vector = {}, scale = 1, contribution = null, source = '') {
  for (const factor of FACTORS) {
    const delta = Number(vector[factor] || 0) * scale;
    target[factor] += delta;
    if (contribution && Math.abs(delta) >= .01) contribution.push({ source, factor, delta: Math.round(delta * 100) / 100 });
  }
}

function softmax(logits) {
  const temperature = 1.35;
  const values = FACTORS.map(key => Math.exp(clamp(logits[key] / temperature, -6, 6)));
  const sum = values.reduce((a, b) => a + b, 0);
  const rounded = Object.fromEntries(FACTORS.map((key, index) => [key, Math.round(values[index] / sum * 1000) / 1000]));
  const drift = Math.round((1 - Object.values(rounded).reduce((a, b) => a + b, 0)) * 1000) / 1000;
  rounded[FACTORS.reduce((best, key) => rounded[key] > rounded[best] ? key : best, FACTORS[0])] += drift;
  return rounded;
}

function inferPreference(answers = {}) {
  const logits = Object.fromEntries(FACTORS.map(key => [key, 0]));
  const contributions = [];
  const archetype = ARCHETYPE_PRIORS[answers.type] ? answers.type : 'normal';
  addVector(logits, ARCHETYPE_PRIORS[archetype], 1, contributions, `游览节奏:${archetype}`);

  for (const [question, vector] of Object.entries(SCALE_MATRIX)) {
    const value = clamp(Number(answers[question] || 3), 1, 5);
    addVector(logits, vector, (value - 3) / 2, contributions, `${question}:${value}`);
  }

  for (const interest of Array.isArray(answers.interests) ? answers.interests : []) {
    if (INTEREST_FACTORS[interest]) addVector(logits, INTEREST_FACTORS[interest], 1, contributions, `兴趣:${interest}`);
  }

  const group = answers.group || 'solo';
  if (group === 'family') addVector(logits, { comfort: .5, interest: .15, time: -.15 }, 1, contributions, '同行:亲子');
  if (group === 'elderly') addVector(logits, { comfort: .75, time: -.25, freedom: -.2 }, 1, contributions, '同行:长者');
  if (group === 'friends') addVector(logits, { freedom: .3, food: .25, performance: .2 }, 1, contributions, '同行:朋友');

  const mobility = answers.mobility || 'normal';
  if (mobility === 'light') addVector(logits, { comfort: .45, time: .1, freedom: -.25 }, 1, contributions, '步行能力:少走路');
  if (mobility === 'minimal') addVector(logits, { comfort: .9, time: .25, freedom: -.5, nature: -.25 }, 1, contributions, '步行能力:尽量少走');

  const weights = softmax(logits);
  const ranked = FACTORS.slice().sort((a, b) => weights[b] - weights[a]);
  const topContributions = contributions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8);
  const answeredScales = Object.keys(SCALE_MATRIX).filter(key => answers[key] !== undefined).length;
  const completeness = Math.round((answeredScales / Object.keys(SCALE_MATRIX).length * .65 + (answers.type ? .15 : 0) + ((answers.interests || []).length ? .1 : 0) + (answers.group ? .05 : 0) + (answers.mobility ? .05 : 0)) * 100);
  const maxWalkPerLeg = mobility === 'minimal' ? 8 : mobility === 'light' ? 14 : 28;
  const maxQueueMin = Number(answers.queue_tolerance || 3) <= 2 ? 12 : Number(answers.queue_tolerance || 3) >= 4 ? 35 : 22;

  return {
    questionnaire_version: '0.2',
    weights,
    labels: LABELS,
    profile: {
      archetype,
      group,
      mobility,
      interests: Array.isArray(answers.interests) ? answers.interests : [],
      top_factors: ranked.slice(0, 3),
      confidence: clamp(completeness, 35, 100)
    },
    constraints: { max_walk_per_leg_min: maxWalkPerLeg, max_queue_min: maxQueueMin, require_rest: Number(answers.rest_need || 3) >= 4 },
    explanation: topContributions,
    planner_rules: {
      max_walk_per_leg_min: maxWalkPerLeg,
      max_queue_min: maxQueueMin,
      score: {
        walk_cost_per_min: mobility === 'minimal' ? .85 : mobility === 'light' ? .58 : .35,
        queue_cost_per_min: Number(answers.crowd_sensitivity || 3) >= 4 ? .72 : .45,
        preference_reward: 34
      }
    }
  };
}

module.exports = { FACTORS, LABELS, SCALE_MATRIX, inferPreference };

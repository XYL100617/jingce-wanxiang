"""Research-only Disneyland wait-time transfer experiment; no app activation.

The source file has no explicit upstream redistribution license. Keep it outside
the repository and use this script only to compare causal forecasting baselines.
"""

import bisect
import csv
import datetime as dt
import hashlib
import json
import math
import pathlib
import sys
from collections import defaultdict

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor


HORIZONS = (30, 60, 120)
BLEND_WEIGHTS = (0.0, 0.1, 0.25, 0.5, 0.75, 1.0)


def source_hash(file_path):
    digest = hashlib.sha256()
    with file_path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def load_rows(file_path):
    by_ride = defaultdict(list)
    with file_path.open(newline='', encoding='utf-8-sig') as source:
        for row in csv.DictReader(source):
            try:
                stamp = dt.datetime.strptime(row['dateTime'], '%Y-%m-%d %H:%M:%S')
                wait = float(row['waitMins'])
            except (KeyError, TypeError, ValueError):
                continue
            if math.isfinite(wait) and 0 <= wait <= 360:
                by_ride[row['rideID']].append((stamp, wait))
    for observations in by_ride.values():
        observations.sort()
    return by_ride


def date_boundaries(by_ride):
    dates = [stamp.date() for observations in by_ride.values() for stamp, _ in observations]
    first, last = min(dates), max(dates)
    span = (last - first).days
    train_end = first + dt.timedelta(days=int(span * .70))
    val_end = first + dt.timedelta(days=int(span * .85))
    return first, train_end, val_end, last


def bucket(date, train_end, val_end):
    return 'train' if date <= train_end else 'val' if date <= val_end else 'test'


def ride_priors(by_ride, train_end):
    values = defaultdict(list)
    slots = defaultdict(list)
    for ride, observations in by_ride.items():
        for stamp, wait in observations:
            if stamp.date() > train_end:
                continue
            values[ride].append(wait)
            slots[(ride, stamp.hour, stamp.weekday() >= 5)].append(wait)
    means = {ride: max(1.0, float(np.mean(v))) for ride, v in values.items()}
    medians = {key: float(np.median(v)) for key, v in slots.items() if len(v) >= 5}
    return means, medians


def make_data(by_ride, horizon, train_end, val_end, means, medians):
    arrays = {name: {'x': [], 'target': [], 'scale': [], 'current': [], 'slot': []}
              for name in ('train', 'val', 'test')}
    tolerance = dt.timedelta(minutes=5)
    for ride, observations in by_ride.items():
        stamps = [item[0] for item in observations]
        scale = means.get(ride, 30.0)
        for i, (stamp, current) in enumerate(observations):
            wanted = stamp + dt.timedelta(minutes=horizon)
            j = bisect.bisect_left(stamps, wanted, i + 1)
            candidates = [k for k in (j - 1, j) if i < k < len(stamps)]
            if not candidates:
                continue
            best = min(candidates, key=lambda k: abs(stamps[k] - wanted))
            target_stamp, target = observations[best]
            if abs(target_stamp - wanted) > tolerance or target_stamp.date() != stamp.date():
                continue
            split = bucket(stamp.date(), train_end, val_end)
            if bucket(target_stamp.date(), train_end, val_end) != split:
                continue
            lag1 = observations[i - 1] if i else (stamp, current)
            lag2 = observations[i - 2] if i > 1 else lag1
            prev1 = lag1[1] if (stamp - lag1[0]).total_seconds() <= 3600 else current
            prev2 = lag2[1] if (stamp - lag2[0]).total_seconds() <= 7200 else prev1
            gap = max(1, (stamp - lag1[0]).total_seconds() / 60)
            hour = stamp.hour + stamp.minute / 60
            angle = 2 * math.pi * hour / 24
            weekend = float(stamp.weekday() >= 5)
            row = arrays[split]
            row['x'].append([current / scale, prev1 / scale, prev2 / scale,
                             (current - prev1) / scale, min(gap, 120) / 120,
                             math.log1p(scale), math.sin(angle), math.cos(angle),
                             hour / 24, weekend])
            row['target'].append(target / scale)
            row['scale'].append(scale)
            row['current'].append(current / scale)
            row['slot'].append(medians.get((ride, target_stamp.hour, bool(weekend)), scale) / scale)
    for row in arrays.values():
        for key in row:
            row[key] = np.asarray(row[key], dtype=np.float64)
    return arrays


def metrics(data, predictions):
    y, scale, current = data['target'], data['scale'], data['current']
    if not len(y):
        return {'n': 0}
    pred = np.maximum(0, predictions)
    result = {'n': int(len(y)),
              'normalized_mae': float(np.mean(np.abs(pred - y))),
              'wait_minutes_mae': float(np.mean(np.abs((pred - y) * scale))),
              'wait_minutes_rmse': float(np.sqrt(np.mean(((pred - y) * scale) ** 2)))}
    high = current * scale >= 30
    change = np.abs((y - current) * scale) >= 10
    for name, mask in [('current_wait_ge_30', high), ('future_change_ge_10', change)]:
        result[name] = {'n': int(np.sum(mask)),
                        'wait_minutes_mae': float(np.mean(np.abs((pred[mask] - y[mask]) * scale[mask]))) if np.any(mask) else None}
    return result


def evaluate_horizon(by_ride, horizon, train_end, val_end, means, medians):
    data = make_data(by_ride, horizon, train_end, val_end, means, medians)
    train, val, test = (data[name] for name in ('train', 'val', 'test'))
    if min(len(train['target']), len(val['target']), len(test['target'])) < 1000:
        raise RuntimeError(f'insufficient samples for {horizon} min')
    rng = np.random.default_rng(20261029 + horizon)
    sample = rng.choice(len(train['target']), min(120000, len(train['target'])), replace=False)
    learner = HistGradientBoostingRegressor(loss='absolute_error', max_iter=100,
        max_leaf_nodes=15, min_samples_leaf=200, l2_regularization=5,
        early_stopping=False, random_state=42)
    learner.fit(train['x'][sample], train['target'][sample])
    val_learned = np.maximum(0, learner.predict(val['x']))
    candidates = []
    for weight in BLEND_WEIGHTS:
        predicted = (1 - weight) * val['current'] + weight * val_learned
        candidates.append({'weight': weight, **metrics(val, predicted)})
    selected = min(candidates, key=lambda item: item['wait_minutes_mae'])['weight']
    test_learned = np.maximum(0, learner.predict(test['x']))
    selected_predictions = (1 - selected) * test['current'] + selected * test_learned
    return {'sample_counts': {name: int(len(row['target'])) for name, row in data.items()},
            'fit_sample_count': int(len(sample)), 'selected_blend_weight_on_validation': selected,
            'validation_candidates': candidates,
            'test': {'persistence': metrics(test, test['current']),
                     'train_slot_median': metrics(test, test['slot']),
                     'learned': metrics(test, test_learned),
                     'selected_blend': metrics(test, selected_predictions)}}


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: python scripts/experiment-external-multi-horizon.py <disneyRideTimes.csv> [report.json]')
    source_path = pathlib.Path(sys.argv[1]).resolve()
    report_path = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else source_path.with_name('external-multi-horizon-report.json')
    by_ride = load_rows(source_path)
    first, train_end, val_end, last = date_boundaries(by_ride)
    means, medians = ride_priors(by_ride, train_end)
    horizons = {}
    for horizon in HORIZONS:
        horizons[str(horizon)] = evaluate_horizon(by_ride, horizon, train_end, val_end, means, medians)
        print(f'{horizon} minute horizon complete', flush=True)
    report = {'dataset': 'Jester565/DisneylandData', 'source_sha256': source_hash(source_path),
              'source_rows': sum(map(len, by_ride.values())), 'ride_count': len(by_ride),
              'source_license': 'No explicit upstream license found; local research comparison only',
              'date_range': {'first': str(first), 'train_end': str(train_end),
                             'validation_end': str(val_end), 'last': str(last)},
              'split_policy': 'chronological date blocks; source and target remain in same date; no random rows',
              'target': 'waitMins at 30/60/120 minutes, nearest same-day reading within 5 minutes',
              'model': 'pooled normalized histogram gradient boosting, absolute-error loss; trained on train dates only',
              'selection': 'blend with persistence selected on validation wait-minute MAE, test used once',
              'horizons': horizons,
              'limitations': ['Disneyland wait minutes are not Wansui wait minutes or crowd counts.',
                              'No event or graph data in this source; does not validate event propagation or route quality.',
                              'Conditioning on future change is an evaluation slice only, not an available online input.']}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(report_path), 'summary': {h: {
        name: score['wait_minutes_mae'] for name, score in result['test'].items()}
        for h, result in horizons.items()}}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

"""Train an isolated cross-domain wait-time baseline; never used by the app."""
import csv
import datetime as dt
import hashlib
import json
import math
import pathlib
import sys
from collections import defaultdict

import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def sha256_file(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_rows(csv_path):
    by_ride = defaultdict(list)
    with open(csv_path, newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            value = row.get("waitMins", "")
            try:
                wait = float(value)
                stamp = dt.datetime.strptime(row["dateTime"], "%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError, KeyError):
                continue
            if not math.isfinite(wait) or wait < 0 or wait > 360:
                continue
            by_ride[row["rideID"]].append((stamp, wait))
    for observations in by_ride.values():
        observations.sort(key=lambda item: item[0])
    return by_ride


def split_rows(by_ride):
    all_dates = [stamp.date() for observations in by_ride.values() for stamp, _ in observations]
    first, last = min(all_dates), max(all_dates)
    span = (last - first).days
    train_end = first + dt.timedelta(days=int(span * 0.70))
    val_end = first + dt.timedelta(days=int(span * 0.85))
    result = {"train": [], "val": [], "test": []}
    train_means = defaultdict(list)
    for ride_id, observations in by_ride.items():
        for index, (stamp, current) in enumerate(observations):
            if stamp.date() <= train_end:
                train_means[ride_id].append(current)
            if index + 1 >= len(observations):
                continue
            next_stamp, target = observations[index + 1]
            gap = (next_stamp - stamp).total_seconds() / 60
            if gap < 20 or gap > 40:
                continue
            previous = observations[index - 1] if index else (None, current)
            previous2 = observations[index - 2] if index > 1 else (None, previous[1])
            lag1 = previous[1] if previous[0] and (stamp - previous[0]).total_seconds() <= 2400 else current
            lag2 = previous2[1] if previous2[0] and (stamp - previous2[0]).total_seconds() <= 4800 else lag1
            hour = stamp.hour + stamp.minute / 60
            dow = stamp.weekday()
            sample = {"ride_id": ride_id, "target_date": next_stamp.date().isoformat(),
                      "current": current, "lag1": lag1, "lag2": lag2, "target": target,
                      "hour_sin": math.sin(2 * math.pi * hour / 24),
                      "hour_cos": math.cos(2 * math.pi * hour / 24),
                      "weekend": float(dow >= 5)}
            bucket = "train" if next_stamp.date() <= train_end else "val" if next_stamp.date() <= val_end else "test"
            result[bucket].append(sample)
    means = {ride: float(np.mean(values)) for ride, values in train_means.items() if values}
    return result, means, {"first_date": first.isoformat(), "last_date": last.isoformat(),
                           "train_end": train_end.isoformat(), "validation_end": val_end.isoformat()}


def matrix(rows, means):
    xs, ys, scales = [], [], []
    for row in rows:
        scale = max(1.0, means.get(row["ride_id"], 30.0))
        ratio = lambda value: value / scale
        xs.append([ratio(row["current"]), ratio(row["lag1"]), ratio(row["lag2"]),
                   math.log1p(scale) / math.log(101), row["hour_sin"], row["hour_cos"], row["weekend"]])
        ys.append(ratio(row["target"]))
        scales.append(scale)
    return np.asarray(xs), np.asarray(ys), np.asarray(scales)


def evaluate(model, rows, means):
    x, y, scales = matrix(rows, means)
    predicted = np.maximum(0, model.predict(x))
    persistence = x[:, 0]
    raw_predicted, raw_y = predicted * scales, y * scales
    return {"n": len(rows), "normalized_mae": float(np.mean(np.abs(predicted - y))),
            "normalized_persistence_mae": float(np.mean(np.abs(persistence - y))),
            "wait_minutes_mae": float(np.mean(np.abs(raw_predicted - raw_y))),
            "wait_minutes_persistence_mae": float(np.mean(np.abs(persistence * scales - raw_y))),
            "target_wait_minutes_mean": float(np.mean(raw_y))}


def evaluate_blend(model, rows, means, weight):
    x, y, scales = matrix(rows, means)
    learned = np.maximum(0, model.predict(x))
    predicted = (1 - weight) * x[:, 0] + weight * learned
    raw_predicted, raw_y = predicted * scales, y * scales
    return {"n": len(rows), "learned_model_weight": weight,
            "normalized_mae": float(np.mean(np.abs(predicted - y))),
            "normalized_persistence_mae": float(np.mean(np.abs(x[:, 0] - y))),
            "wait_minutes_mae": float(np.mean(np.abs(raw_predicted - raw_y))),
            "wait_minutes_persistence_mae": float(np.mean(np.abs(x[:, 0] * scales - raw_y)))}


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scripts/train-external-wait-dynamics.py <disneyRideTimes.csv> [report.json]")
    csv_path = pathlib.Path(sys.argv[1]).resolve()
    report_path = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else csv_path.with_name("disney-wait-dynamics-report.json")
    by_ride = load_rows(csv_path)
    splits, means, boundaries = split_rows(by_ride)
    if not splits["train"] or not splits["val"] or not splits["test"]:
        raise RuntimeError("temporal split produced an empty split")
    # Select regularization only on the middle time window; the final period stays untouched.
    x_train_candidate, y_train_candidate, _ = matrix(splits["train"], means)
    x_val, y_val, _ = matrix(splits["val"], means)
    candidates = []
    for alpha in (0.01, 0.1, 1.0, 10.0, 100.0):
        model = make_pipeline(StandardScaler(), Ridge(alpha=alpha))
        model.fit(x_train_candidate, y_train_candidate)
        candidates.append((float(np.mean(np.abs(model.predict(x_val) - y_val))), alpha))
    best_alpha = min(candidates)[1]
    trainval = splits["train"] + splits["val"]
    # Recompute ride means from information available before the held-out test period.
    test_start = dt.date.fromisoformat(boundaries["validation_end"]) + dt.timedelta(days=1)
    trainval_means = defaultdict(list)
    for ride, observations in by_ride.items():
        for stamp, wait in observations:
            if stamp.date() < test_start:
                trainval_means[ride].append(wait)
    means = {ride: float(np.mean(values)) for ride, values in trainval_means.items() if values}
    x_train, y_train, _ = matrix(trainval, means)
    model = make_pipeline(StandardScaler(), Ridge(alpha=best_alpha))
    model.fit(x_train, y_train)
    ridge_metrics = {name: evaluate(model, rows, means) for name, rows in splits.items()}
    x_val, y_val, _ = matrix(splits["val"], means)
    boosting_candidates = []
    for max_leaf_nodes in (15, 31):
        candidate = HistGradientBoostingRegressor(max_iter=160, learning_rate=0.08,
            max_leaf_nodes=max_leaf_nodes, min_samples_leaf=100, l2_regularization=5.0,
            early_stopping=False, random_state=42)
        candidate.fit(x_train, y_train)
        boosting_candidates.append((float(np.mean(np.abs(candidate.predict(x_val) - y_val))), max_leaf_nodes))
    best_leaf_nodes = min(boosting_candidates)[1]
    boosted = HistGradientBoostingRegressor(max_iter=160, learning_rate=0.08,
        max_leaf_nodes=best_leaf_nodes, min_samples_leaf=100, l2_regularization=5.0,
        early_stopping=False, random_state=42)
    boosted.fit(x_train, y_train)
    boosted_metrics = {name: evaluate(boosted, rows, means) for name, rows in splits.items()}
    blend_candidates = []
    for weight in (0.0, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0):
        blend_candidates.append((evaluate_blend(boosted, splits["val"], means, weight)["normalized_mae"], weight))
    best_blend_weight = min(blend_candidates)[1]
    blend_metrics = {name: evaluate_blend(boosted, rows, means, best_blend_weight)
                     for name, rows in splits.items()}
    metrics = blend_metrics
    report = {"model_type": "cross-domain pooled standardized wait-time models (ridge and histogram gradient boosting)",
              "source": {"dataset": "Jester565/DisneylandData", "download_url": "https://s3-us-west-2.amazonaws.com/disneyridetimes/disneyRideTimes.csv",
                         "repository_url": "https://github.com/Jester565/DisneylandData",
                         "license": "No explicit license found in repository; research-only local copy; do not redistribute"},
              "source_data": {"path": str(csv_path), "bytes": csv_path.stat().st_size,
                              "sha256": sha256_file(csv_path),
                              "rows_with_numeric_wait": sum(map(len, by_ride.values())),
                              "ride_count": len(by_ride), **boundaries},
              "target_definition": "next valid waitMins observation 20-40 minutes after current, numeric wait values only",
              "split_policy": "chronological 70/15/15 by dataset date range; no random row split",
              "feature_names": ["current_wait/ride_train_mean", "lag1/ride_train_mean", "lag2/ride_train_mean",
                                "log_ride_train_mean", "hour_sin", "hour_cos", "weekend"],
              "alpha_candidates_validation_mae": [{"alpha": alpha, "normalized_mae": mae} for mae, alpha in candidates],
              "selected_alpha": best_alpha,
              "boosting_candidates_validation_mae": [{"max_leaf_nodes": leaves, "normalized_mae": mae}
                                                      for mae, leaves in boosting_candidates],
              "selected_max_leaf_nodes": best_leaf_nodes,
              "blend_validation_candidates": [{"learned_model_weight": weight, "normalized_mae": mae}
                                              for mae, weight in blend_candidates],
              "selected_blend_weight": best_blend_weight,
              "model_comparison": {"ridge": ridge_metrics, "hist_gradient_boosting": boosted_metrics,
                                   "persistence_blend": blend_metrics},
              "metrics": metrics,
              "limitations": ["Disneyland ride waits are not Wansui POI queue counts or footfall.",
                              "No Wansui POI matching or graph adjacency exists in this source.",
                              "This is an external temporal baseline only; it is not integrated into the Wansui world model or route planner."]}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "source_data": report["source_data"],
                      "metrics": metrics, "selected_alpha": best_alpha}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

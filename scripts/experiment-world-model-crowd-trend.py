"""Train/evaluate a lightweight, graph-aware crowd-ratio trend model.

Research experiment only. Inputs and labels are T4 synthetic simulation data;
the output report is not evidence of real-world Wansui accuracy.
"""

import datetime as dt
import hashlib
import json
import math
import pathlib
import sys
from collections import defaultdict

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import average_precision_score, brier_score_loss, mean_absolute_error


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_GRAPH_PATH = ROOT / "server" / "data" / "scenic_graph.json"
HORIZONS = (("target_5", 5), ("target_15", 15), ("target_30", 30), ("target_60", 60))
SPLITS = ("train", "val", "test")
FEATURES = ["own_crowd_ratio", "own_queue_count", "log1p_own_queue_count", "poi_open",
    "poi_capacity_scaled", "neighbor_crowd_mean", "neighbor_crowd_max", "neighbor_queue_mean",
    "incident_road_delay_ratio", "incident_road_closed_fraction", "local_event_load_scaled",
    "global_event_load_scaled", "local_event_countdown", "scheduled_event_capacity_scaled",
    "hour_sin", "hour_cos", "rain", "hot", "lag1_crowd_ratio", "lag2_crowd_ratio", "horizon_scaled"]


def load_rows(folder):
    result = {}
    for split in SPLITS:
        with (folder / f"{split}.jsonl").open(encoding="utf-8") as stream:
            result[split] = [json.loads(line) for line in stream if line.strip()]
    return result


def prepare_graph(graph):
    nodes = {node["node_id"]: node for node in graph["nodes"]}
    pois = {node["poi_id"]: node for node in graph["nodes"] if node.get("poi_id")}
    adjacent = defaultdict(set)
    incident = defaultdict(list)
    for edge in graph["edges"]:
        a, b = edge["from_node_id"], edge["to_node_id"]
        adjacent[a].add(b)
        adjacent[b].add(a)
        incident[a].append(edge["edge_id"])
        incident[b].append(edge["edge_id"])
    edges = {edge["edge_id"]: edge for edge in graph["edges"]}
    return nodes, pois, adjacent, incident, edges


def parse_time(value):
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            return dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None


def make_features(row, poi_id, horizon_min, graph_parts, history):
    nodes, pois, adjacent, incident, edges = graph_parts
    observation = row["OBSERVED_INPUT"]["observation"]
    node = pois.get(poi_id)
    if node is None:
        return None
    node_id = node["node_id"]
    local_nodes = {node_id, *adjacent[node_id]}
    neighbor_pois = [nodes[n].get("poi_id") for n in adjacent[node_id] if nodes[n].get("poi_id")]
    poi_state = observation.get("pois", {}).get(poi_id, {})
    crowd = poi_state.get("crowd_ratio")
    queue = poi_state.get("queue_count")
    if not isinstance(crowd, (int, float)):
        return None
    neighbor_states = [observation.get("pois", {}).get(pid, {}) for pid in neighbor_pois]
    neighbor_crowds = [s.get("crowd_ratio") for s in neighbor_states if isinstance(s.get("crowd_ratio"), (int, float))]
    neighbor_queues = [s.get("queue_count") for s in neighbor_states if isinstance(s.get("queue_count"), (int, float))]
    roads = observation.get("roads", {})
    edge_ids = incident[node_id]
    ratios = []
    for edge_id in edge_ids:
        edge = edges[edge_id]
        state = roads.get(edge_id, {})
        base = edge.get("base_travel_time_min")
        actual = state.get("travel_time_min")
        if isinstance(base, (int, float)) and base > 0 and isinstance(actual, (int, float)):
            ratios.append(actual / base)
    active_events = list((observation.get("events") or {}).values())
    now = parse_time(observation.get("timestamp"))
    local_load = 0.0
    global_load = 0.0
    countdown = 0.0
    target_window = 0.0
    if now:
        target_time = now + dt.timedelta(minutes=horizon_min)
        for event in active_events:
            event_node = event.get("node_id")
            weight = 1.0 if event_node == node_id else 0.5 if event_node in local_nodes else 0.0
            load = float(event.get("event_queue_count") or 0) + float(event.get("attending_count") or 0)
            global_load += load
            local_load += weight * load
            starts = parse_time(event.get("boarding_open_time") or event.get("start_time"))
            ends = parse_time(event.get("end_time"))
            if weight and starts:
                minutes = abs((starts - now).total_seconds()) / 60
                if minutes <= 120:
                    countdown += weight * (1 - minutes / 120)
                if ends and starts <= target_time <= ends and event.get("cancelled") is not True:
                    target_window += weight * float(event.get("capacity") or load)
    hour = now.hour + now.minute / 60 if now else 12.0
    weather = observation.get("weather", {}).get("category")
    lag = history.get((row["METADATA"]["trajectory_id"], row["METADATA"]["step_index"]), [])
    lag_values = []
    for old in lag[-2:]:
        value = old.get("pois", {}).get(poi_id, {}).get("crowd_ratio")
        lag_values.append(value if isinstance(value, (int, float)) else crowd)
    while len(lag_values) < 2:
        lag_values.insert(0, crowd)
    return [round(float(value), 12) for value in [
        float(crowd), float(queue or 0), math.log1p(max(0, float(queue or 0))),
        float(poi_state.get("is_open") is True),
        float(node.get("capacity") or 0) / 1000,
        float(np.mean(neighbor_crowds)) if neighbor_crowds else float(crowd),
        float(max(neighbor_crowds)) if neighbor_crowds else float(crowd),
        float(np.mean(neighbor_queues)) if neighbor_queues else 0.0,
        float(np.mean(ratios)) if ratios else 1.0,
        float(sum(roads.get(edge_id, {}).get("is_open") is False for edge_id in edge_ids)) / max(1, len(edge_ids)),
        local_load / 100, global_load / 100, countdown, target_window / 100,
        math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24),
        float(weather == "RAIN"), float(weather == "HOT"),
        lag_values[-1], lag_values[-2], horizon_min / 60,
    ]]


def build_split(rows, key, horizon, graph_parts, feature_history):
    features, targets, current, group_ids = [], [], [], []
    for row in rows:
        if row["FUTURE_TARGET"].get("availability", {}).get(key) is not True:
            continue
        target_pois = row["FUTURE_TARGET"][key]["environment"].get("pois", {})
        for poi_id, future in target_pois.items():
            if future.get("is_open") is not True:
                continue
            feature = make_features(row, poi_id, horizon, graph_parts, feature_history)
            if feature is None:
                continue
            y = future.get("crowd_ratio")
            if not isinstance(y, (int, float)):
                continue
            features.append(feature)
            targets.append(float(y))
            current.append(float(row["OBSERVED_INPUT"]["observation"]["pois"][poi_id]["crowd_ratio"]))
            group_ids.append(row["METADATA"].get("scenario_instance_id", "unknown"))
    return np.asarray(features), np.asarray(targets), np.asarray(current), group_ids


def score(y, pred, current):
    return {"n": int(len(y)), "mae": float(mean_absolute_error(y, pred)),
            "persistence_mae": float(mean_absolute_error(y, current)),
            "zero_mae": float(mean_absolute_error(y, np.zeros_like(y)))}


def serialize_hgb(model):
    trees = []
    for iteration in model._predictors:
        nodes = iteration[0].nodes
        trees.append([[int(n["feature_idx"]), float(n["num_threshold"]), int(n["left"]),
            int(n["right"]), bool(n["missing_go_to_left"]), bool(n["is_leaf"]), float(n["value"])]
            for n in nodes])
    return {"baseline": float(model._baseline_prediction.ravel()[0]), "trees": trees}


def serialized_predict(model, matrix, classifier=False):
    result = np.full(len(matrix), model["baseline"], dtype=float)
    for tree in model["trees"]:
        for row_index, row in enumerate(matrix):
            node_index = 0
            while not tree[node_index][5]:
                feature, threshold, left, right, missing_left = tree[node_index][:5]
                value = row[feature]
                node_index = left if ((not np.isfinite(value) and missing_left)
                    or (np.isfinite(value) and value <= threshold)) else right
            result[row_index] += tree[node_index][6]
    if classifier:
        result = 1 / (1 + np.exp(-np.clip(result, -40, 40)))
    return result


def group_scores(y, pred, current, groups):
    grouped = defaultdict(list)
    for index, group in enumerate(groups):
        grouped[group].append(index)
    values = {}
    for group, indices in grouped.items():
        idx = np.asarray(indices)
        values[group] = {"n": int(len(idx)),
            "model_mae": float(mean_absolute_error(y[idx], pred[idx])),
            "persistence_mae": float(mean_absolute_error(y[idx], current[idx]))}
    return values


def bootstrap_gain(groups, seed=41029, draws=3000):
    items = list(groups.values())
    gains = np.asarray([row["persistence_mae"] - row["model_mae"] for row in items])
    rng = np.random.default_rng(seed)
    samples = np.mean(rng.choice(gains, size=(draws, len(gains)), replace=True), axis=1)
    return {"mean_group_mae_gain": float(gains.mean()),
            "group_bootstrap_95pct_ci": [float(np.quantile(samples, 0.025)), float(np.quantile(samples, 0.975))],
            "positive_gain_groups": int(np.sum(gains > 0)), "test_group_count": int(len(gains))}


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scripts/experiment-world-model-crowd-trend.py <dataset>/environment [report.json]")
    data_dir = pathlib.Path(sys.argv[1]).resolve()
    report_path = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ROOT / "server/world-model/crowd-trend-experiment-v0.1.json"
    rows = load_rows(data_dir)
    all_rows = [r for split in SPLITS for r in rows[split]]
    by_trajectory = defaultdict(list)
    for row in all_rows:
        by_trajectory[row["METADATA"]["trajectory_id"]].append(row)
    histories = {}
    for trajectory_id, trajectory in by_trajectory.items():
        trajectory.sort(key=lambda item: item["METADATA"]["step_index"])
        for index, row in enumerate(trajectory):
            histories[(trajectory_id, row["METADATA"]["step_index"])] = [
                item["OBSERVED_INPUT"]["observation"] for item in trajectory[max(0, index - 2):index]
            ]
    graph_path = pathlib.Path(sys.argv[4]).resolve() if len(sys.argv) > 4 else DEFAULT_GRAPH_PATH
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    graph_parts = prepare_graph(graph)
    graph_contract = {
        "nodes": sorted([[node["node_id"], node.get("poi_id")] for node in graph["nodes"]]),
        "edges": sorted([[edge["edge_id"], edge["from_node_id"], edge["to_node_id"]] for edge in graph["edges"]]),
    }
    manifest_path = data_dir.parent / "dataset_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    simulator_version = manifest.get("simulator_version") or rows["train"][0]["METADATA"].get("simulator_version")
    graph_contract["feature_graph"] = {
        "node_capacities": sorted([[node["node_id"], node.get("capacity")] for node in graph["nodes"]]),
        "edge_base_travel_times": sorted([[edge["edge_id"], edge.get("base_travel_time_min")] for edge in graph["edges"]]),
    }
    artifact = {"schema_version": "crowd-trend-hgb-0.1", "model_version": "synthetic-map1-crowd-trend-v0.1",
        "source_tier": "T4", "synthetic": True, "dataset_version": manifest.get("dataset_version", "unknown"),
        "simulator_version": simulator_version,
        "target": "future crowd_ratio and probability of crowd_ratio increase >= 0.03",
        "graph_contract": graph_contract, "feature_names": FEATURES, "horizon_models": {}}
    output = {"dataset_path": str(data_dir), "source_tier": "T4", "synthetic": True,
              "dataset_version": manifest.get("dataset_version", "unknown"),
              "dataset_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest() if manifest_path.exists() else None,
              "target": "future crowd_ratio and upward trend (future-current >= 0.03) per open Map1 POI",
              "split_policy": "use precomputed train/val/test whole scenario-seed groups; validation selects persistence blend; test is held out",
              "models": {}}
    for key, horizon in HORIZONS:
        train = build_split(rows["train"], key, horizon, graph_parts, histories)
        val = build_split(rows["val"], key, horizon, graph_parts, histories)
        test = build_split(rows["test"], key, horizon, graph_parts, histories)
        reg = HistGradientBoostingRegressor(loss="absolute_error", max_iter=160,
            learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=100,
            l2_regularization=5.0, early_stopping=False, random_state=41)
        reg.fit(train[0], train[1])
        pred_val = np.clip(reg.predict(val[0]), 0, 1)
        candidates = []
        for weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            blend = (1 - weight) * val[2] + weight * pred_val
            candidates.append({"model_weight": weight, **score(val[1], blend, val[2])})
        selected = min(candidates, key=lambda item: item["mae"])["model_weight"]
        pred_test = np.clip(reg.predict(test[0]), 0, 1)
        blended_test = (1 - selected) * test[2] + selected * pred_test
        rise_model = HistGradientBoostingClassifier(max_iter=160, learning_rate=0.05,
            max_leaf_nodes=15, min_samples_leaf=80, l2_regularization=5.0,
            early_stopping=False, random_state=42)
        rise_model.fit(train[0], (train[1] - train[2] >= 0.03).astype(int))
        rise_prob_test = rise_model.predict_proba(test[0])[:, 1]
        portable_reg = serialize_hgb(reg)
        portable_risk = serialize_hgb(rise_model)
        check_x = val[0][:128]
        reg_check = np.clip(serialized_predict(portable_reg, check_x), 0, 1)
        reg_expected = np.clip(reg.predict(check_x), 0, 1)
        risk_check = serialized_predict(portable_risk, check_x, classifier=True)
        risk_expected = rise_model.predict_proba(check_x)[:, 1]
        max_diff = float(max(np.max(np.abs(reg_check - reg_expected)), np.max(np.abs(risk_check - risk_expected))))
        if max_diff > 1e-6:
            raise RuntimeError(f"portable tree inference mismatch: {max_diff}")
        artifact["horizon_models"][str(horizon)] = {"crowd_ratio_regressor": portable_reg,
            "upward_trend_classifier": portable_risk, "upward_trend_threshold": 0.03,
            "validation_blend_weight": selected, "portable_inference_max_abs_error": max_diff}
        prevalence = float(np.mean((test[1] - test[2]) >= 0.03))
        rise = {"threshold": 0.03, "prevalence": prevalence,
            "prevalence_baseline_ap": prevalence,
            "test_ap": float(average_precision_score((test[1] - test[2] >= 0.03).astype(int), rise_prob_test)),
            "test_brier": float(brier_score_loss((test[1] - test[2] >= 0.03).astype(int), rise_prob_test)),
            "constant_prevalence_brier": float(brier_score_loss((test[1] - test[2] >= 0.03).astype(int), np.full(len(test[1]), np.mean((train[1] - train[2]) >= 0.03)))),
            "top10_precision": float(np.mean((test[1][np.argsort(rise_prob_test)[-max(1, len(test[1]) // 10):]] - test[2][np.argsort(rise_prob_test)[-max(1, len(test[1]) // 10):]]) >= 0.03))}
        per_group = group_scores(test[1], blended_test, test[2], test[3])
        output["models"][str(horizon)] = {"train_n": int(len(train[1])),
            "validation_model": score(val[1], pred_val, val[2]),
            "validation_persistence": score(val[1], val[2], val[2]),
            "validation_candidates": candidates, "selected_model_weight": selected,
            "test_persistence": score(test[1], test[2], test[2]),
            "test_zero": score(test[1], np.zeros_like(test[1]), test[2]),
            "test_model": score(test[1], pred_test, test[2]),
            "test_validation_selected_blend": score(test[1], blended_test, test[2]),
            "test_group_bootstrap": bootstrap_gain(per_group, seed=41029 + horizon),
            "test_group_metrics": per_group,
            "upward_trend": rise,
            "training_groups": len(set(train[3])), "test_groups": len(set(test[3]))}
        print(f"{horizon}m complete", flush=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if len(sys.argv) > 3:
        artifact_path = pathlib.Path(sys.argv[3]).resolve()
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(json.dumps(artifact, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "summary": {
        h: {k: v for k, v in item.items() if k in ("selected_model_weight", "test_persistence", "test_model", "test_validation_selected_blend", "upward_trend")}
        for h, item in output["models"].items()}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

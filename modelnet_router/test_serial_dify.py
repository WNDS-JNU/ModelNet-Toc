from __future__ import annotations

import json
import unittest

from modelnet_gateway.serial_dify import (
    SerialTopologyError,
    build_serial_dify_dsl,
    parse_serial_topology,
)


def topology(nodes: list[str], edges: list[tuple[str, str]]) -> dict:
    return {
        "version": "modelnet.serial.v1",
        "nodes": [
            {"id": f"step-{index + 1}", "modelId": model_id}
            for index, model_id in enumerate(nodes)
        ],
        "edges": [{"source": source, "target": target} for source, target in edges],
    }


class SerialTopologyTests(unittest.TestCase):
    def test_valid_linear_chain_is_ordered(self) -> None:
        parsed = parse_serial_topology(
            topology(
                ["model-a", "model-b", "model-c"],
                [("step-1", "step-2"), ("step-2", "step-3")],
            )
        )

        self.assertEqual(parsed.ordered_model_ids, ["model-a", "model-b", "model-c"])
        self.assertEqual(
            parsed.as_payload()["edges"],
            [
                {"source": "step-1", "target": "step-2"},
                {"source": "step-2", "target": "step-3"},
            ],
        )
        self.assertEqual(len(parsed.hash), 24)

    def test_rejects_less_than_two_nodes(self) -> None:
        with self.assertRaisesRegex(SerialTopologyError, "at least two"):
            parse_serial_topology(topology(["model-a"], []))

    def test_rejects_fork(self) -> None:
        with self.assertRaisesRegex(SerialTopologyError, "outgoing"):
            parse_serial_topology(
                topology(
                    ["model-a", "model-b", "model-c"],
                    [("step-1", "step-2"), ("step-1", "step-3")],
                )
            )

    def test_rejects_cycle(self) -> None:
        with self.assertRaisesRegex(SerialTopologyError, "start and one end|connected"):
            parse_serial_topology(
                topology(
                    ["model-a", "model-b"],
                    [("step-1", "step-2"), ("step-2", "step-1")],
                )
            )

    def test_rejects_unknown_model_edge_node(self) -> None:
        with self.assertRaisesRegex(SerialTopologyError, "unknown target"):
            parse_serial_topology(
                {
                    "version": "modelnet.serial.v1",
                    "nodes": [{"id": "step-1", "modelId": "model-a"}, {"id": "step-2", "modelId": "model-b"}],
                    "edges": [{"source": "step-1", "target": "step-x"}],
                }
            )

    def test_compiler_outputs_start_llm_end_nodes(self) -> None:
        parsed = parse_serial_topology(
            topology(["model-a", "model-b"], [("step-1", "step-2")])
        )
        dsl = json.loads(
            build_serial_dify_dsl(
                parsed,
                provider="langgenius/openai_api_compatible/openai_api_compatible",
                max_tokens=512,
                temperature=0.2,
            )
        )

        graph = dsl["workflow"]["graph"]
        node_types = [node["data"]["type"] for node in graph["nodes"]]
        self.assertEqual(node_types, ["start", "llm", "llm", "end"])
        self.assertEqual(len(graph["edges"]), 3)
        self.assertEqual(graph["nodes"][1]["data"]["model"]["name"], "model-a")
        self.assertEqual(graph["nodes"][2]["data"]["model"]["name"], "model-b")
        self.assertEqual(
            graph["nodes"][-1]["data"]["outputs"][0]["value_selector"],
            ["llm_step_2", "text"],
        )

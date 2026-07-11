import { describe, expect, it } from "vitest";

import { stripModelNetFlowContent } from "./modelnetTraceContent";

describe("stripModelNetFlowContent", () => {
  it("removes ModelNet workflow prose while keeping the final answer", () => {
    const content = [
      "**ModelNet 自动组网流程**",
      "",
      "- 已进入自动组网：根据问题特征、候选模型、置信度和运行预算选择拓扑。",
      "- 规划完成：策略 `adaptive`，runner `auto.network`，聚合器 `auto`，计划调用 3 个节点，置信度 `0.83`。",
      "- 节点 `source-a` 绑定模型 `qwen3`（角色 `source`）。",
      "- 自动组网执行完成，内部调用 3 次，内部 tokens 640。",
      "",
      "最终答案第一段。",
      "- 用户答案里的列表项应该保留。",
    ].join("\n");

    expect(stripModelNetFlowContent(content)).toBe(
      ["最终答案第一段。", "- 用户答案里的列表项应该保留。"].join("\n"),
    );
  });

  it("removes compact ModelNet event markers from visible content", () => {
    const markerBoundary = String.fromCodePoint(0x1E);
    const content = [
      "前言",
      `${markerBoundary}MODELNET_EVENT:{"type":"source.started","sourceId":"s1"}${markerBoundary}`,
      "正文",
    ].join("\n");

    expect(stripModelNetFlowContent(content)).toBe(["前言", "正文"].join("\n"));
  });
});

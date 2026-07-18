const MODELNET_EVENT_MARKER_BOUNDARY = String.fromCodePoint(0x1E);
const MODELNET_EVENT_MARKER_PREFIX = `${MODELNET_EVENT_MARKER_BOUNDARY}MODELNET_EVENT:`;

const MODELNET_FLOW_HEADING_PATTERN = /^\*\*ModelNet (?:并联|串联|自动组网)流程\*\*\s*$/;

const MODELNET_FLOW_LINE_PATTERNS = [
  /^-\s+已启动并联运行/,
  /^-\s+并联发起/,
  /^-\s+`[^`]+`\s+已完成/,
  /^-\s+`[^`]+`\s+失败/,
  /^-\s+response\.parallel synthesis starting/,
  /^-\s+synthesis prompt exceeded/,
  /^-\s+source summaries are ready/,
  /^-\s+已启动串联运行/,
  /^-\s+串联拓扑已就绪/,
  /^-\s+第\s*\d+\s*步(?:选中模型|上下文已压缩|触发可见答案恢复|完成)/,
  /^-\s+已进入自动组网/,
  /^-\s+规划完成/,
  /^-\s+拓扑阶段/,
  /^-\s+已选择模型节点/,
  /^-\s+升级\/路由原因/,
  /^-\s+节点\s+`[^`]+`\s+绑定模型/,
  /^-\s+阶段\s+`[^`]+`\s+已更新/,
  /^-\s+自动组网执行完成/,
];

const isModelNetFlowLine = (line: string) =>
  MODELNET_FLOW_HEADING_PATTERN.test(line) ||
  MODELNET_FLOW_LINE_PATTERNS.some((pattern) => pattern.test(line));

const stripModelNetEventMarkers = (line: string) => {
  let next = line;
  let removed = false;

  while (true) {
    const start = next.indexOf(MODELNET_EVENT_MARKER_PREFIX);
    if (start === -1) return { line: next, removed };

    const end = next.indexOf(MODELNET_EVENT_MARKER_BOUNDARY, start + MODELNET_EVENT_MARKER_PREFIX.length);
    removed = true;

    if (end === -1) {
      return { line: next.slice(0, start), removed };
    }

    next = next.slice(0, start) + next.slice(end + MODELNET_EVENT_MARKER_BOUNDARY.length);
  }
};

export const stripModelNetFlowContent = (content: string) => {
  const lines = content.split("\n");
  const kept: string[] = [];
  let removedAnyLine = false;
  let removedPreviousLine = false;

  for (const line of lines) {
    const markerResult = stripModelNetEventMarkers(line);
    const lineWithoutMarkers = markerResult.line;

    if (markerResult.removed) {
      removedAnyLine = true;
    }

    if (lineWithoutMarkers.trim() === "" && markerResult.removed) {
      removedPreviousLine = true;
      continue;
    }

    if (isModelNetFlowLine(lineWithoutMarkers.trim())) {
      removedAnyLine = true;
      removedPreviousLine = true;
      continue;
    }

    if (removedPreviousLine && lineWithoutMarkers.trim() === "") {
      continue;
    }

    removedPreviousLine = false;
    kept.push(lineWithoutMarkers);
  }

  return removedAnyLine ? kept.join("\n").replace(/^\s+/, "") : content;
};

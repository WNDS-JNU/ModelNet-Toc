import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const DATA_DIR =
  process.env.MODELNET_LEADERBOARD_DATA_DIR || path.join(process.cwd(), 'leaderboard', 'data');

type LocalizedText = string | Record<string, string>;
type JsonObject = Record<string, unknown>;

interface SourceGroup {
  id: string;
  name: LocalizedText;
}

interface NormalizedPayload extends JsonObject {
  errors?: unknown[];
  items: JsonObject[];
  modelnet_summary?: unknown;
  source: JsonObject & {
    id?: string;
    name?: LocalizedText;
  };
}

const OPENCOMPASS_GROUP = {
  id: 'opencompass',
  name: {
    'en-US': 'OpenCompass',
    'zh-CN': '\u53f8\u5357 OpenCompass',
  },
} satisfies SourceGroup;

const LOCAL_GROUP = {
  id: 'local',
  name: {
    'en-US': 'ModelNet Benchmark',
    'zh-CN': 'ModelNet \u81ea\u6d4b',
  },
} satisfies SourceGroup;

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isLocalizedText = (value: unknown): value is LocalizedText =>
  typeof value === 'string' ||
  (isObject(value) && Object.values(value).every((item) => typeof item === 'string'));

const asObjectArray = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);

const EMPTY_OPENCOMPASS: NormalizedPayload = {
  errors: [],
  generated_at: null,
  items: [],
  modelnet_summary: {},
  source: {
    name: OPENCOMPASS_GROUP.name,
    status: 'missing',
  },
};

const readJsonFile = async (fileName: string): Promise<JsonObject | null> => {
  try {
    const content = await readFile(path.join(DATA_DIR, fileName), 'utf8');
    const parsed = JSON.parse(content) as unknown;

    return isObject(parsed) ? parsed : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;

    throw error;
  }
};

const sourceId = (source: unknown) =>
  isObject(source) && typeof source.id === 'string' ? source.id : undefined;

const sourceName = (source: JsonObject, fallback: LocalizedText) =>
  isLocalizedText(source.name) ? source.name : fallback;

const withSourceGroup = (item: JsonObject, group: SourceGroup) => {
  const originalSource = isObject(item.source) ? item.source : {};

  return {
    ...item,
    source: {
      ...originalSource,
      id: sourceId(originalSource) || group.id,
      name: group.name,
    },
  };
};

const normalizeOpenCompassPayload = (payload: JsonObject | null): NormalizedPayload => {
  if (!payload) return EMPTY_OPENCOMPASS;

  const payloadSource = isObject(payload.source) ? payload.source : {};
  const items = asObjectArray(payload.items);

  return {
    ...payload,
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    items: items.map((item) => withSourceGroup(item, OPENCOMPASS_GROUP)),
    source: {
      ...payloadSource,
      id: OPENCOMPASS_GROUP.id,
      name: OPENCOMPASS_GROUP.name,
    },
  };
};

const normalizeLocalPayload = (payload: JsonObject | null): NormalizedPayload => {
  if (!payload) {
    return {
      generated_at: null,
      items: [],
      source: {
        ...LOCAL_GROUP,
        status: 'missing',
      },
    };
  }

  const source = isObject(payload.source) ? payload.source : {};
  const group = {
    id: LOCAL_GROUP.id,
    name: sourceName(source, LOCAL_GROUP.name),
  };

  return {
    ...payload,
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    items: asObjectArray(payload.items).map((item) => {
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.filter((alias) => typeof alias === 'string')
        : [];

      return withSourceGroup(
        {
          modelnet_ids: aliases,
          modelnet_matched: true,
          ...item,
          source: {
            ...source,
            id: LOCAL_GROUP.id,
          },
        },
        group,
      );
    }),
    source: {
      ...source,
      id: LOCAL_GROUP.id,
      name: group.name,
    },
  };
};

const countBySource = (items: JsonObject[]) =>
  items.reduce<Record<string, number>>((acc, item) => {
    const id = sourceId(item.source) || 'unknown';
    acc[id] = (acc[id] || 0) + 1;
    return acc;
  }, {});

export async function GET() {
  try {
    const [openCompassRaw, localRaw] = await Promise.all([
      readJsonFile('opencompass-leaderboard.json'),
      readJsonFile('local-benchmarks.json'),
    ]);

    const openCompass = normalizeOpenCompassPayload(openCompassRaw);
    const local = normalizeLocalPayload(localRaw);
    const items = [...openCompass.items, ...local.items];
    const counts = countBySource(items);

    return NextResponse.json({
      errors: [...(openCompass.errors || []), ...(local.errors || [])],
      generated_at: new Date().toISOString(),
      items,
      modelnet_summary: isObject(openCompass.modelnet_summary) ? openCompass.modelnet_summary : {},
      source: {
        name: {
          'en-US': 'ModelNet leaderboard',
          'zh-CN': 'ModelNet \u6a21\u578b\u6392\u884c',
        },
        sources: [OPENCOMPASS_GROUP, local.source].map((source) => ({
          ...source,
          count: counts[source.id] || 0,
        })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load leaderboard data',
        items: [],
      },
      { status: 500 },
    );
  }
}

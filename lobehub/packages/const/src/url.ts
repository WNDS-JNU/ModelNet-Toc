import urlJoin from 'url-join';

const isDev = process.env.NODE_ENV === 'development';

export const OFFICIAL_URL = 'https://www.jnu.edu.cn';
export const OFFICIAL_SITE = 'https://www.jnu.edu.cn';
export const OFFICIAL_DOMAIN = 'jnu.edu.cn';

export const OG_URL = '/og/og.webp?v=1';

export const GITHUB = 'https://www.jnu.edu.cn';
export const GITHUB_ISSUES = GITHUB;
export const CHANGELOG = 'https://www.jnu.edu.cn/2567/list.htm';

export const DOCUMENTS = OFFICIAL_SITE;
export const USAGE_DOCUMENTS = urlJoin(DOCUMENTS, '/usage');
export const SELF_HOSTING_DOCUMENTS = urlJoin(DOCUMENTS, '/self-hosting');
export const DATABASE_SELF_HOSTING_URL = urlJoin(SELF_HOSTING_DOCUMENTS, '/server-database');

// use this for the link
export const DOCUMENTS_REFER_URL = `${DOCUMENTS}?utm_source=chat_preview`;

export const WIKI_PLUGIN_GUIDE = urlJoin(USAGE_DOCUMENTS, '/plugins/development');
export const MANUAL_UPGRADE_URL = urlJoin(SELF_HOSTING_DOCUMENTS, '/advanced/upstream-sync');

export const BLOG = 'https://news.jnu.edu.cn';

export const ABOUT = OFFICIAL_SITE;
export const FEEDBACK = OFFICIAL_SITE;
export const PRIVACY_URL = OFFICIAL_SITE;
export const TERMS_URL = OFFICIAL_SITE;

export const PLUGINS_INDEX_URL = 'https://www.jnu.edu.cn';

export const MORE_MODEL_PROVIDER_REQUEST_URL = 'https://www.jnu.edu.cn';

export const MORE_FILE_PREVIEW_REQUEST_URL = 'https://www.jnu.edu.cn';

export const AGENTS_INDEX_GITHUB = 'https://www.jnu.edu.cn';
export const AGENTS_INDEX_GITHUB_ISSUE = OFFICIAL_SITE;
export const AGENTS_OFFICIAL_URL = 'https://www.jnu.edu.cn';

export const SESSION_CHAT_URL = (agentId: string, mobile?: boolean) => {
  if (mobile) return `/agent/${agentId}`;
  return `/agent/${agentId}`;
};

export const SESSION_CHAT_TOPIC_URL = (agentId: string, topicId: string, mobile?: boolean) => {
  if (mobile) return urlJoin('/agent', agentId, topicId);
  return urlJoin('/agent', agentId, topicId);
};

export const SESSION_CHAT_TOPIC_PAGE_URL = (agentId: string, topicId: string, mobile?: boolean) => {
  if (mobile) return urlJoin('/agent', agentId, topicId, 'page');
  return urlJoin('/agent', agentId, topicId, 'page');
};

export const AGENT_PROFILE_URL = (agentId: string) => `/agent/${agentId}/profile`;

export const GROUP_CHAT_URL = (groupId: string) => `/group/${groupId}`;

export const LIBRARY_URL = (id: string) => urlJoin('/resource/library', id);

export const imageUrl = (filename: string) => `/images/${filename}`;

export const LOBE_URL_IMPORT_NAME = 'settings';

export const RELEASES_URL = CHANGELOG;

export const mailTo = (email: string) => `mailto:${email}`;

export const AES_GCM_URL = 'https://datatracker.ietf.org/doc/html/draft-ietf-avt-srtp-aes-gcm-01';
export const BASE_PROVIDER_DOC_URL = OFFICIAL_SITE;
export const SITEMAP_BASE_URL = isDev ? '/sitemap.xml/' : 'sitemap';
export const CHANGELOG_URL = CHANGELOG;

export const DOWNLOAD_URL = {
  android: 'https://www.jnu.edu.cn',
  default: OFFICIAL_SITE,
  ios: 'https://www.jnu.edu.cn',
} as const;

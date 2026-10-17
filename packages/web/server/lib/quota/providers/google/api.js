/**
 * Google Provider - API
 *
 * API calls for Google quota providers.
 * @module quota/providers/google/api
 */

const GOOGLE_PRIMARY_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GOOGLE_DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';

const GOOGLE_ENDPOINTS = [
  GOOGLE_DAILY_ENDPOINT,
  GOOGLE_PRIMARY_ENDPOINT
];

const GOOGLE_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
};

export const refreshGoogleAccessToken = async (refreshToken, clientId, clientSecret) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return typeof data?.access_token === 'string' ? data.access_token : null;
};

const groupHasBucketPrefix = (group, prefix) => (
  Array.isArray(group?.buckets)
  && group.buckets.some((bucket) => (
    typeof bucket?.bucketId === 'string' && bucket.bucketId.startsWith(prefix)
  ))
);

/**
 * Merges an incoming quota-summary group into an accumulated list, keyed by
 * `displayName`, keeping the first non-empty bucket per `bucketId`. This lets
 * us assemble a complete summary from partial responses.
 *
 * @param {Array<object>} groups
 * @param {object} incoming
 * @returns {Array<object>}
 */
const mergeQuotaGroups = (groups, incoming) => {
  const incomingBuckets = Array.isArray(incoming?.buckets) ? incoming.buckets : [];
  if (!incomingBuckets.length) {
    return groups;
  }

  const displayName = typeof incoming?.displayName === 'string' ? incoming.displayName : '';
  const existing = groups.find((group) => (
    (typeof group?.displayName === 'string' ? group.displayName : '') === displayName
  ));

  if (!existing) {
    return [...groups, { ...incoming, buckets: [...incomingBuckets] }];
  }

  const seen = new Set(existing.buckets.map((bucket) => bucket?.bucketId));
  for (const bucket of incomingBuckets) {
    const bucketId = bucket?.bucketId;
    if (bucketId && seen.has(bucketId)) {
      continue;
    }
    existing.buckets.push(bucket);
    if (bucketId) {
      seen.add(bucketId);
    }
  }

  return groups;
};

/**
 * Fetches the grouped quota summary (weekly + 5h buckets per model family:
 * gemini and 3p/non-gemini) from the Cloud Code `retrieveUserQuotaSummary`
 * endpoint. This is the authoritative source for the Antigravity weekly limit;
 * `retrieveUserQuota` only carries per-model snapshots.
 *
 * The daily endpoint is queried first, but it is known to reply 200 with a
 * *partial* summary (e.g. only the 3p / Claude-GPT group, omitting gemini), so
 * groups are merged across endpoints until the gemini group is recovered.
 *
 * @param {string} accessToken
 * @param {string} [projectId]
 * @returns {Promise<{ groups: Array<object> } | null>}
 */
export const fetchGoogleQuotaSummary = async (accessToken, projectId) => {
  const body = projectId ? { project: projectId } : {};
  let mergedGroups = [];

  for (const endpoint of GOOGLE_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...GOOGLE_HEADERS
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const groups = Array.isArray(payload?.groups) ? payload.groups : [];
      if (!groups.length) {
        continue;
      }

      for (const group of groups) {
        mergedGroups = mergeQuotaGroups(mergedGroups, group);
      }

      // A partial daily response can omit the gemini group; keep querying the
      // remaining endpoints until it is recovered.
      if (mergedGroups.some((group) => groupHasBucketPrefix(group, 'gemini-'))) {
        break;
      }
    } catch {
      continue;
    }
  }

  if (!mergedGroups.length) {
    return null;
  }

  return { groups: mergedGroups };
};

export const fetchGoogleQuotaBuckets = async (accessToken, projectId) => {
  const body = projectId ? { project: projectId } : {};

  try {
    const response = await fetch(`${GOOGLE_PRIMARY_ENDPOINT}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
};

export const fetchGoogleModels = async (accessToken, projectId) => {
  const body = projectId ? { project: projectId } : {};

  for (const endpoint of GOOGLE_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...GOOGLE_HEADERS
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      if (response.ok) {
        return await response.json();
      }
    } catch {
      continue;
    }
  }

  return null;
};

/**
 * Deterministic tests for the Google provider HTTP boundary (api.js).
 *
 * No domain mocks (no vi.mock / jest.mock): instead of faking the business
 * layer we install a real *transport recorder* at the global `fetch` seam. It
 * records every outbound request (URL + init) and answers with controlled HTTP
 * responses. This pinpoints the exact hosts the provider is allowed to reach
 * (daily-cloudcode-pa + cloudcode-pa) and proves the obsolete `.sandbox` /
 * `autopush` hosts were removed, all without touching the network.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels,
  fetchGoogleQuotaSummary,
  GOOGLE_HEADERS
} from './api.js';

const SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';
const DAILY_SUMMARY_URL = `https://daily-cloudcode-pa.googleapis.com${SUMMARY_PATH}`;
const PRIMARY_SUMMARY_URL = `https://cloudcode-pa.googleapis.com${SUMMARY_PATH}`;

const realFetch = globalThis.fetch;

const installFetchRecorder = (handler) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ?? null
    };
    calls.push(record);
    const reply = handler(record, calls.length) ?? {};
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return calls;
};

const ALLOWED_HOSTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('google provider api.js endpoints', () => {
  it('fetchGoogleModels calls the daily endpoint first with the project body', async () => {
    const calls = installFetchRecorder(() => ({ body: { models: { 'gemini-3.8-flash': {} } } }));

    const payload = await fetchGoogleModels('access-token', 'project-xyz');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body)).toEqual({ project: 'project-xyz' });
    expect(payload.models['gemini-3.8-flash']).toBeDefined();
  });

  it('fetchGoogleModels falls back to the primary endpoint when the daily host fails', async () => {
    const calls = installFetchRecorder((_record, attempt) => (
      attempt === 1 ? { status: 503 } : { body: { models: { 'gemini-3.8-flash': {} } } }
    ));

    const payload = await fetchGoogleModels('access-token', 'project-xyz');

    expect(calls.map((call) => call.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
    ]);
    expect(payload.models['gemini-3.8-flash']).toBeDefined();
  });

  it('never targets obsolete .sandbox / autopush hosts', async () => {
    const calls = installFetchRecorder(() => ({ status: 503 }));

    const payload = await fetchGoogleModels('access-token', null);

    expect(payload).toBeNull();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).not.toMatch(/sandbox|autopush|preprod/i);
      expect(ALLOWED_HOSTS.some((host) => call.url.startsWith(host))).toBe(true);
    }
  });

  it('fetchGoogleQuotaBuckets targets the primary retrieveUserQuota endpoint', async () => {
    const calls = installFetchRecorder(() => ({
      body: { buckets: [{ modelId: 'gemini-3.8-flash', remainingFraction: 0.5 }] }
    }));

    const payload = await fetchGoogleQuotaBuckets('access-token', 'project-xyz');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
    expect(calls[0].method).toBe('POST');
    expect(payload.buckets).toHaveLength(1);
  });

  it('fetchGoogleQuotaBuckets fails closed (null) on a non-ok response without throwing', async () => {
    installFetchRecorder(() => ({ status: 500 }));

    await expect(fetchGoogleQuotaBuckets('access-token', 'project-xyz')).resolves.toBeNull();
  });

  it('refreshGoogleAccessToken posts the refresh grant and returns the access_token', async () => {
    const calls = installFetchRecorder(() => ({ body: { access_token: 'fresh-token' } }));

    const token = await refreshGoogleAccessToken('refresh-abc', 'client-id', 'client-secret');

    expect(token).toBe('fresh-token');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].method).toBe('POST');

    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-abc');
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
  });

  it('refreshGoogleAccessToken returns null on a non-ok response', async () => {
    installFetchRecorder(() => ({ status: 400 }));

    await expect(refreshGoogleAccessToken('refresh-abc', 'client-id', 'client-secret')).resolves.toBeNull();
  });

  it('refreshGoogleAccessToken returns null when the payload lacks access_token', async () => {
    installFetchRecorder(() => ({ body: { token_type: 'Bearer' } }));

    await expect(refreshGoogleAccessToken('refresh-abc', 'client-id', 'client-secret')).resolves.toBeNull();
  });
});

describe('google provider api.js — fetchGoogleQuotaSummary', () => {
  const geminiGroup = (remainingFraction = 0.73) => ({
    displayName: 'gemini',
    buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction }]
  });

  it('queries the daily endpoint first and returns its groups without touching the primary host', async () => {
    const calls = installFetchRecorder(() => ({ body: { groups: [geminiGroup()] } }));

    const summary = await fetchGoogleQuotaSummary('access-token', 'project-xyz');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DAILY_SUMMARY_URL);
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body)).toEqual({ project: 'project-xyz' });
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].displayName).toBe('gemini');
    expect(summary.groups[0].buckets[0].bucketId).toBe('gemini-weekly');
    expect(summary.groups[0].buckets[0].remainingFraction).toBe(0.73);
  });

  it('sends an empty body when no project id is provided', async () => {
    const calls = installFetchRecorder(() => ({ body: { groups: [geminiGroup()] } }));

    await fetchGoogleQuotaSummary('access-token');

    expect(JSON.parse(calls[0].body)).toEqual({});
  });

  it('falls back to the primary endpoint when the daily endpoint returns a non-ok status', async () => {
    const calls = installFetchRecorder((_record, attempt) => (
      attempt === 1 ? { status: 500 } : { body: { groups: [geminiGroup()] } }
    ));

    const summary = await fetchGoogleQuotaSummary('access-token', 'project-xyz');

    expect(calls.map((call) => call.url)).toEqual([DAILY_SUMMARY_URL, PRIMARY_SUMMARY_URL]);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].buckets[0].bucketId).toBe('gemini-weekly');
  });

  it('merges groups across endpoints when the daily response omits the gemini group', async () => {
    const calls = installFetchRecorder((record) => {
      if (record.url === DAILY_SUMMARY_URL) {
        return {
          body: {
            groups: [{
              displayName: '3p',
              buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 }]
            }]
          }
        };
      }
      return { body: { groups: [geminiGroup()] } };
    });

    const summary = await fetchGoogleQuotaSummary('access-token', 'project-xyz');

    expect(calls.map((call) => call.url)).toEqual([DAILY_SUMMARY_URL, PRIMARY_SUMMARY_URL]);
    const displayNames = summary.groups.map((group) => group.displayName).sort();
    expect(displayNames).toEqual(['3p', 'gemini']);
    expect(summary.groups.find((group) => group.displayName === '3p').buckets[0].bucketId).toBe('3p-weekly');
    expect(summary.groups.find((group) => group.displayName === 'gemini').buckets[0].bucketId).toBe('gemini-weekly');
  });

  it('keeps the first bucket per bucketId when the same displayName appears on both endpoints', async () => {
    const calls = installFetchRecorder((record) => {
      if (record.url === DAILY_SUMMARY_URL) {
        return {
          body: {
            groups: [{
              displayName: '3p',
              buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 }]
            }]
          }
        };
      }
      return {
        body: {
          groups: [
            {
              displayName: '3p',
              buckets: [
                { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.99 },
                { bucketId: '3p-5h', window: '5h', remainingFraction: 0.1 }
              ]
            },
            geminiGroup()
          ]
        }
      };
    });

    const summary = await fetchGoogleQuotaSummary('access-token', 'project-xyz');

    expect(calls.map((call) => call.url)).toEqual([DAILY_SUMMARY_URL, PRIMARY_SUMMARY_URL]);
    const threeP = summary.groups.find((group) => group.displayName === '3p');
    expect(threeP.buckets).toHaveLength(2);
    // The daily bucket (0.5) won over the primary duplicate (0.99).
    const weekly = threeP.buckets.find((bucket) => bucket.bucketId === '3p-weekly');
    expect(weekly.remainingFraction).toBe(0.5);
  });

  it('fails closed (null) without throwing when every endpoint returns a non-ok status', async () => {
    const calls = installFetchRecorder(() => ({ status: 500 }));

    await expect(fetchGoogleQuotaSummary('access-token', 'project-xyz')).resolves.toBeNull();
    expect(calls.map((call) => call.url)).toEqual([DAILY_SUMMARY_URL, PRIMARY_SUMMARY_URL]);
  });

  it('fails closed (null) when the payload carries no groups', async () => {
    installFetchRecorder(() => ({ body: { groups: [] } }));

    await expect(fetchGoogleQuotaSummary('access-token', null)).resolves.toBeNull();
  });

  it('fails closed (null) and swallows transport errors thrown by every endpoint', async () => {
    const calls = installFetchRecorder(() => {
      throw new Error('network down');
    });

    await expect(fetchGoogleQuotaSummary('access-token', 'project-xyz')).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('sends modern antigravity/2.24.0 headers ensuring daily endpoint returns Gemini Models', async () => {
    const calls = installFetchRecorder(() => ({ body: { groups: [geminiGroup()] } }));

    await fetchGoogleQuotaSummary('access-token', 'project-xyz');

    expect(calls).toHaveLength(1);
    expect(GOOGLE_HEADERS['User-Agent']).toBe('antigravity/2.24.0 linux/amd64');
    expect(JSON.parse(GOOGLE_HEADERS['Client-Metadata'])).toEqual({
      ideType: 'IDE_TYPE_ANTIGRAVITY',
      platform: 'PLATFORM_LINUX',
      pluginType: 'GEMINI'
    });
    expect(calls[0].headers['User-Agent']).toBe('antigravity/2.24.0 linux/amd64');
    expect(calls[0].headers['Client-Metadata']).toBe(GOOGLE_HEADERS['Client-Metadata']);
  });
});

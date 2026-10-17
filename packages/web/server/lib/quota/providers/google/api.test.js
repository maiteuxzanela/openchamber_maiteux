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
  fetchGoogleModels
} from './api.js';

const realFetch = globalThis.fetch;

const installFetchRecorder = (handler) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init?.method ?? 'GET',
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

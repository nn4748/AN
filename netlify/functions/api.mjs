import { getStore } from '@netlify/blobs';
import { createApi } from '../../lib/core.mjs';

let handle;

function blobStore() {
  const s = getStore({ name: 'nourah-aziz', consistency: 'strong' });
  return {
    get: (k) => s.get(k, { type: 'json' }),
    set: (k, v) => s.setJSON(k, v),
    del: (k) => s.delete(k),
    list: async (prefix) => (await s.list({ prefix })).blobs.map((b) => b.key),
  };
}

export default async (req, context) => {
  handle ||= createApi({ store: blobStore(), passcodeHash: process.env.PASSCODE_HASH || undefined });
  return handle(req, context.ip);
};

export const config = { path: '/api/*' };

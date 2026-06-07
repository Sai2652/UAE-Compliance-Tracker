// Thin Supabase client wrapper. Lazily initialized so the app can boot even
// before env vars are set (compliance features will then return clear errors).
const { createClient } = require('@supabase/supabase-js');

let client = null;
let ready = false;

function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — compliance features disabled');
    return null;
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  ready = true;
  return client;
}

function isReady() { return ready || !!getClient(); }

async function probe() {
  const c = getClient();
  if (!c) return { ok: false, error: 'missing_env' };
  const { error } = await c.from('compliance_priority_config').select('key').limit(1);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = { getClient, isReady, probe };

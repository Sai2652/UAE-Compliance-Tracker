// ClientSettingsRepo — admin-set per-client metadata (tier, partner owner, notes).
const { getClient } = require('../supabase');
function pg() { const c = getClient(); if (!c) throw new Error('Storage not configured'); return c; }

const ClientSettingsRepo = {
  async getForClient(clientId) {
    const { data } = await pg().from('compliance_client_settings').select('*').eq('client_external_id', String(clientId)).maybeSingle();
    return data;
  },
  async getAll() {
    const { data, error } = await pg().from('compliance_client_settings').select('*');
    if (error) throw error;
    return data || [];
  },
  async upsert(clientId, payload, actor) {
    const row = Object.assign(
      { client_external_id: String(clientId), updated_at: new Date().toISOString() },
      payload || {}
    );
    if (actor) { row.updated_by_id = actor.id; row.updated_by_name = actor.name; }
    const { data, error } = await pg().from('compliance_client_settings').upsert(row, { onConflict: 'client_external_id' }).select('*').single();
    if (error) throw error;
    return data;
  }
};

module.exports = { ClientSettingsRepo };

// Obligations data layer — Supabase-backed, mirrors compliance.js style.
const { getClient } = require('./supabase');

function sb() { const c = getClient(); if (!c) throw new Error('Supabase not configured'); return c; }

const obligations = {
  async upsert(input) {
    const row = {
      client_external_id: String(input.clientId),
      client_name: input.clientName,
      obligation_type: input.obligationType,
      period_label: input.periodLabel,
      period_start: input.periodStart || null,
      period_end: input.periodEnd || null,
      filing_deadline: input.filingDeadline,
      payment_deadline: input.paymentDeadline || null,
      source_key: input.sourceKey,
      metadata: input.metadata || {},
      updated_at: new Date().toISOString()
    };
    if (input.status) row.status = input.status;
    const { data, error } = await sb().from('compliance_obligations')
      .upsert(row, { onConflict: 'source_key' })
      .select('*').single();
    if (error) throw error;
    return data;
  },

  async list(filter = {}) {
    let q = sb().from('compliance_obligations').select('*');
    if (filter.clientId) q = q.eq('client_external_id', String(filter.clientId));
    if (filter.type)     q = Array.isArray(filter.type) ? q.in('obligation_type', filter.type) : q.eq('obligation_type', filter.type);
    if (filter.status)   q = Array.isArray(filter.status) ? q.in('status', filter.status) : q.eq('status', filter.status);
    if (filter.from)     q = q.gte('filing_deadline', filter.from);
    if (filter.to)       q = q.lte('filing_deadline', filter.to);
    q = q.order('filing_deadline', { ascending: true }).limit(filter.limit || 1000);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getById(id) {
    const { data } = await sb().from('compliance_obligations').select('*').eq('id', id).maybeSingle();
    return data;
  },

  async setStatus(id, status, extra = {}) {
    const patch = { status, updated_at: new Date().toISOString(), ...extra };
    if (status === 'filed') patch.filed_at = new Date().toISOString();
    const { data, error } = await sb().from('compliance_obligations').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },

  async deleteForClient(clientId, fromDeadline) {
    // Used when settings change and we want to refresh future obligations.
    // We only delete future, non-filed obligations.
    let q = sb().from('compliance_obligations').delete().eq('client_external_id', String(clientId)).neq('status', 'filed');
    if (fromDeadline) q = q.gte('filing_deadline', fromDeadline);
    const { error } = await q;
    if (error) throw error;
  }
};

module.exports = { obligations };

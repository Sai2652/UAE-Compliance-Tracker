// WorkflowsRepo — provider-agnostic data access for workflows + steps.
// Composes into repositories/index.js. Keeps Supabase types out of services.
const { getClient } = require('../supabase');
function pg() { const c = getClient(); if (!c) throw new Error('Storage not configured'); return c; }

const WorkflowsRepo = {
  async getBySourceKey(key) {
    const { data } = await pg().from('compliance_workflows').select('*').eq('source_key', key).maybeSingle();
    return data;
  },
  async getById(id) {
    const { data } = await pg().from('compliance_workflows').select('*').eq('id', id).maybeSingle();
    return data;
  },
  async create(row) {
    const { data, error } = await pg().from('compliance_workflows').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505' && row.source_key) return this.getBySourceKey(row.source_key);
      throw error;
    }
    return data;
  },
  async update(id, patch) {
    patch.updated_at = new Date().toISOString();
    const { data, error } = await pg().from('compliance_workflows').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },
  async list(filter = {}) {
    let q = pg().from('compliance_workflows').select('*');
    if (filter.clientId)     q = q.eq('client_external_id', String(filter.clientId));
    if (filter.workflowType) q = Array.isArray(filter.workflowType) ? q.in('workflow_type', filter.workflowType) : q.eq('workflow_type', filter.workflowType);
    if (filter.status)       q = Array.isArray(filter.status) ? q.in('status', filter.status) : q.eq('status', filter.status);
    q = q.order('updated_at', { ascending: false }).limit(filter.limit || 1000);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
};

const WorkflowStepsRepo = {
  async listForWorkflow(workflowId) {
    const { data, error } = await pg().from('compliance_workflow_steps').select('*').eq('workflow_id', workflowId).order('step_order', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async bulkInsert(rows) {
    if (!rows.length) return [];
    const { data, error } = await pg().from('compliance_workflow_steps').insert(rows).select('*');
    if (error) throw error;
    return data || [];
  },
  async update(id, patch) {
    const { data, error } = await pg().from('compliance_workflow_steps').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },
  async getById(id) {
    const { data } = await pg().from('compliance_workflow_steps').select('*').eq('id', id).maybeSingle();
    return data;
  }
};

module.exports = { WorkflowsRepo, WorkflowStepsRepo };

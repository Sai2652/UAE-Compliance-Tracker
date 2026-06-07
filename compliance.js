// Compliance data layer — Supabase-backed.
// Mirrors the style of database.js (named module with method bags) so api.js
// stays consistent. All functions are async.
const { getClient } = require('./supabase');

const TASK_STATUSES = [
  'not_started','waiting_documents','documents_received','in_progress',
  'ready_for_review','reviewed','completed','blocked','escalated'
];
const TERMINAL_STATUSES = ['completed'];

function sb() {
  const c = getClient();
  if (!c) throw new Error('Supabase not configured');
  return c;
}

// ---------- Priority config ----------
const config = {
  async getAll() {
    const { data, error } = await sb().from('compliance_priority_config').select('*');
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { map[r.key] = Number(r.value); });
    return map;
  },
  async set(key, value) {
    const { error } = await sb()
      .from('compliance_priority_config')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
  }
};

// ---------- Tasks ----------
const tasks = {
  async create(input) {
    const row = {
      client_external_id: String(input.clientId),
      client_name: input.clientName,
      task_type: input.taskType,
      title: input.title || null,
      description: input.description || null,
      assigned_user_id: input.assignedUserId || null,
      assigned_user_name: input.assignedUserName || null,
      status: input.status || 'not_started',
      due_date: input.dueDate || null,
      compliance_deadline: input.complianceDeadline || null,
      source: input.source || 'manual',
      source_key: input.sourceKey || null,
      metadata: input.metadata || {},
      created_by: input.createdBy || null
    };
    const { data, error } = await sb().from('compliance_tasks').insert(row).select('*').single();
    if (error) {
      // Unique-violation on source_key means generator already created it — return existing.
      if (error.code === '23505' && row.source_key) {
        return this.findBySourceKey(row.source_key);
      }
      throw error;
    }
    return data;
  },

  async findBySourceKey(key) {
    const { data } = await sb().from('compliance_tasks').select('*').eq('source_key', key).maybeSingle();
    return data;
  },

  async getById(id) {
    const { data, error } = await sb().from('compliance_tasks').select('*').eq('id', id).single();
    if (error) return null;
    return data;
  },

  async list(filter = {}) {
    let q = sb().from('compliance_tasks').select('*');
    if (filter.assignedUserId) q = q.eq('assigned_user_id', filter.assignedUserId);
    if (filter.clientId)       q = q.eq('client_external_id', String(filter.clientId));
    if (filter.status)         q = Array.isArray(filter.status) ? q.in('status', filter.status) : q.eq('status', filter.status);
    if (filter.notStatus)      q = q.not('status','in',`(${filter.notStatus.map(s=>`"${s}"`).join(',')})`);
    if (filter.overdue)        q = q.lt('due_date', new Date().toISOString().slice(0,10)).not('status','in','("completed")');
    if (filter.dueBefore)      q = q.lte('due_date', filter.dueBefore);
    const order = filter.orderBy || 'priority_score';
    q = q.order(order, { ascending: false }).limit(filter.limit || 500);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async update(id, patch) {
    patch.updated_at = new Date().toISOString();
    const { data, error } = await sb().from('compliance_tasks').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },

  async setStatus(id, status, extra = {}) {
    if (!TASK_STATUSES.includes(status)) throw new Error('Invalid status');
    const patch = { status, last_status_change: new Date().toISOString(), ...extra };
    if (TERMINAL_STATUSES.includes(status)) patch.completed_date = new Date().toISOString();
    return this.update(id, patch);
  },

  async setPriorityScore(id, score) {
    return this.update(id, { priority_score: score });
  },

  async bulkUpdatePriorities(rows) {
    // rows: [{id, priority_score}]
    if (!rows.length) return;
    // Postgres has no easy bulk-update via supabase-js; do small batched upserts.
    const chunks = [];
    for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(r =>
        sb().from('compliance_tasks').update({ priority_score: r.priority_score, updated_at: new Date().toISOString() }).eq('id', r.id)
      ));
    }
  },

  async delete(id) {
    const { error } = await sb().from('compliance_tasks').delete().eq('id', id);
    if (error) throw error;
  }
};

// ---------- Comments ----------
const comments = {
  async listForTask(taskId) {
    const { data, error } = await sb().from('compliance_task_comments').select('*').eq('task_id', taskId).order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async add(taskId, userId, userName, body) {
    const { data, error } = await sb().from('compliance_task_comments')
      .insert({ task_id: taskId, user_id: userId, user_name: userName, body })
      .select('*').single();
    if (error) throw error;
    return data;
  }
};

// ---------- Document requests ----------
const documents = {
  async create(input) {
    const row = {
      task_id: input.taskId || null,
      client_external_id: String(input.clientId),
      client_name: input.clientName,
      document_name: input.documentName,
      notes: input.notes || null,
      requested_by_id: input.requestedById || null,
      requested_by_name: input.requestedByName || null
    };
    const { data, error } = await sb().from('compliance_document_requests').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },
  async list(filter = {}) {
    let q = sb().from('compliance_document_requests').select('*');
    if (filter.status)   q = q.eq('status', filter.status);
    if (filter.clientId) q = q.eq('client_external_id', String(filter.clientId));
    if (filter.taskId)   q = q.eq('task_id', filter.taskId);
    q = q.order('requested_date', { ascending: false }).limit(filter.limit || 500);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
  async remind(id) {
    const { data, error } = await sb().from('compliance_document_requests')
      .update({ last_reminder_date: new Date().toISOString() })
      .eq('id', id).select('*').single();
    if (error) throw error;
    // Increment reminder_count atomically via rpc-less pattern: fetch+update
    await sb().from('compliance_document_requests')
      .update({ reminder_count: (data.reminder_count || 0) + 1 }).eq('id', id);
    return data;
  },
  async markReceived(id) {
    const { data, error } = await sb().from('compliance_document_requests')
      .update({ status: 'received', received_date: new Date().toISOString() })
      .eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  }
};

// ---------- Generation rules ----------
const generationRules = {
  async listActive() {
    const { data, error } = await sb().from('compliance_task_generation_rules').select('*').eq('active', true);
    if (error) throw error;
    return data || [];
  }
};

module.exports = { tasks, comments, documents, config, generationRules, TASK_STATUSES };

// Client Settings — tier and partner-owner. Admin can override at any time;
// reason is captured for audit/governance.
const repos = require('../../repositories');

const DEFAULT_TIER = 'B';
const VALID_TIERS = ['A','B','C'];

async function get(clientId) {
  const row = await repos.ClientSettingsRepo.getForClient(clientId);
  return normalize(row, clientId);
}
async function getAllAsMap() {
  const rows = await repos.ClientSettingsRepo.getAll();
  const map = {};
  rows.forEach(r => { map[String(r.client_external_id)] = normalize(r, r.client_external_id); });
  return map;
}
async function set(clientId, patch, actor) {
  if (patch.tier && !VALID_TIERS.includes(patch.tier)) throw new Error('Invalid tier');
  const payload = {};
  ['tier','partner_owner','notes','override_reason'].forEach(k => { if (patch[k] !== undefined) payload[k] = patch[k]; });
  const saved = await repos.ClientSettingsRepo.upsert(clientId, payload, actor);
  // Activity log for governance trail.
  repos.ActivityRepo.log(actor && actor.id, actor && actor.name, 'client_settings_updated',
    `clientId=${clientId} ${JSON.stringify(payload)}${payload.override_reason ? ' reason="' + payload.override_reason + '"' : ''}`);
  return normalize(saved, clientId);
}

async function tierMultipliers() {
  const cfg = await repos.WorkloadConfigRepo.getAll();
  return {
    A: cfg.tier_a_multiplier != null ? Number(cfg.tier_a_multiplier) : 1.5,
    B: cfg.tier_b_multiplier != null ? Number(cfg.tier_b_multiplier) : 1.0,
    C: cfg.tier_c_multiplier != null ? Number(cfg.tier_c_multiplier) : 0.75
  };
}

function normalize(row, clientId) {
  if (!row) {
    return {
      clientId: String(clientId),
      tier: DEFAULT_TIER,
      partnerOwner: null,
      notes: null,
      overrideReason: null,
      updatedAt: null,
      updatedByName: null,
      isDefault: true
    };
  }
  return {
    clientId: String(row.client_external_id || clientId),
    tier: row.tier || DEFAULT_TIER,
    partnerOwner: row.partner_owner || null,
    notes: row.notes || null,
    overrideReason: row.override_reason || null,
    updatedAt: row.updated_at || null,
    updatedByName: row.updated_by_name || null,
    isDefault: false
  };
}

module.exports = { get, getAllAsMap, set, tierMultipliers, VALID_TIERS, DEFAULT_TIER };

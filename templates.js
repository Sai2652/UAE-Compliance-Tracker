// Workflow templates — code-resident so the DB stays lean.
// Keys are stable string identifiers; labels are display strings.
// To add a new workflow type, append here; no DB change needed.

const VAT_FILING_STEPS = [
  { key: 'Accounting_Completed',           label: 'Accounting Completed' },
  { key: 'Accounting_Reviewed',            label: 'Accounting Reviewed' },
  { key: 'VAT_Working_Prepared',           label: 'VAT Working Prepared' },
  { key: 'Internal_Review_Completed',      label: 'Internal Review Completed' },
  { key: 'Client_Confirmation_Obtained',   label: 'Client Confirmation Obtained' },
  { key: 'VAT_Return_Filed',               label: 'VAT Return Filed' },
  { key: 'Filing_Acknowledgement_Verified',label: 'Filing Acknowledgement Verified' }
];

const CT_FILING_STEPS = [
  { key: 'Accounting_Completed',           label: 'Accounting Completed' },
  { key: 'Accounting_Reviewed',            label: 'Accounting Reviewed' },
  { key: 'CT_Computation_Prepared',        label: 'CT Computation Prepared' },
  { key: 'Internal_Review_Completed',      label: 'Internal Review Completed' },
  { key: 'Client_Confirmation_Obtained',   label: 'Client Confirmation Obtained' },
  { key: 'CT_Return_Filed',                label: 'CT Return Filed' },
  { key: 'Filing_Acknowledgement_Verified',label: 'Filing Acknowledgement Verified' }
];

const ACCOUNTING_STEPS = [
  { key: 'Bookkeeping_Pending',  label: 'Bookkeeping Pending' },
  { key: 'In_Progress',          label: 'Bookkeeping In Progress' },
  { key: 'Completed',            label: 'Bookkeeping Completed' },
  { key: 'Under_Review',         label: 'Under Review' },
  { key: 'Review_Completed',     label: 'Review Completed' }
];

const TEMPLATES = {
  VAT_Filing:  { steps: VAT_FILING_STEPS,  filingStepKey: 'VAT_Return_Filed',
                 confirmationStepKey: 'Client_Confirmation_Obtained' },
  CT_Filing:   { steps: CT_FILING_STEPS,   filingStepKey: 'CT_Return_Filed',
                 confirmationStepKey: 'Client_Confirmation_Obtained' },
  Accounting:  { steps: ACCOUNTING_STEPS,  filingStepKey: null,
                 confirmationStepKey: null }
};

function getTemplate(workflowType) {
  return TEMPLATES[workflowType] || null;
}

module.exports = { TEMPLATES, getTemplate };

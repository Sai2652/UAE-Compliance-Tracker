// AWS SDK wrapper — lazy-initialized DynamoDB Document + S3 clients.
// Same shape as supabase.js so the swap in repositories/ is minimal.
//
// Env vars honoured:
//   AWS_REGION                (default: 'ap-south-1' — Mumbai)
//   UCT_DDB_TABLE_PREFIX      (default: 'Uct')  — every table name is <prefix><Suffix>
//   UCT_S3_BUCKET             (required for trackerStateRepo)
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — either these OR an IAM role (Lambda).
//   AWS_ENDPOINT_URL          (optional — for DynamoDB Local / localstack testing)

let ddbDoc = null;
let s3 = null;
let ready = false;

function region() { return process.env.AWS_REGION || 'ap-south-1'; }
function prefix() { return process.env.UCT_DDB_TABLE_PREFIX || 'Uct'; }
function bucketName() { return process.env.UCT_S3_BUCKET || ''; }

function tableName(suffix) { return prefix() + suffix; }

function getDdb() {
  if (ddbDoc) return ddbDoc;
  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    const clientOpts = { region: region() };
    if (process.env.AWS_ENDPOINT_URL) clientOpts.endpoint = process.env.AWS_ENDPOINT_URL;
    const raw = new DynamoDBClient(clientOpts);
    ddbDoc = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true }
    });
    ready = true;
    return ddbDoc;
  } catch (e) {
    console.warn('[aws] DynamoDB client init failed:', e.message);
    return null;
  }
}

function getS3() {
  if (s3) return s3;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    const clientOpts = { region: region() };
    if (process.env.AWS_ENDPOINT_URL) { clientOpts.endpoint = process.env.AWS_ENDPOINT_URL; clientOpts.forcePathStyle = true; }
    s3 = new S3Client(clientOpts);
    return s3;
  } catch (e) {
    console.warn('[aws] S3 client init failed:', e.message);
    return null;
  }
}

function isReady() {
  if (ready) return true;
  return !!getDdb();
}

async function probe() {
  const c = getDdb();
  if (!c) return { ok: false, error: 'ddb_init_failed' };
  // Lightweight table describe against the users table; if bootstrap hasn't run
  // yet we get ResourceNotFoundException — that's a clean signal.
  try {
    const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const raw = new DynamoDBClient({ region: region(), endpoint: process.env.AWS_ENDPOINT_URL });
    await raw.send(new DescribeTableCommand({ TableName: tableName('Users') }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name || e.message };
  }
}

module.exports = { getDdb, getS3, isReady, probe, tableName, bucketName, region };

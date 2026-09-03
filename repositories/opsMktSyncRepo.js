// Which First POCs this tracker follows in Ops-Mkt, and when it last looked.
//
// Deliberately its own S3 object rather than a field on tracker_state.json.
// That file is the client list, and its save path overwrites the whole blob —
// putting settings in there would mean every settings write touched the code
// path that holds all 400-odd clients. Nothing about the sync selection is
// worth that risk, so it lives on its own key.

const { getS3, bucketName } = require('../aws');

const KEY = 'opsmkt_sync.json';

const EMPTY = {
  pocs: [],            // First POC names this tracker follows
  activeOnly: true,    // ignore disengaged / on-hold clients
  autoSync: true,      // let the nightly sweep add newly signed clients
  lastSyncAt: null,
  lastSyncResult: null // { added, skipped, at, by }
};

function streamToString(stream) {
  return new Promise(function(resolve, reject) {
    const chunks = [];
    stream.on('data', function(c) { chunks.push(c); });
    stream.on('error', reject);
    stream.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

const OpsMktSyncRepo = {
  async load() {
    const c = getS3();
    const bucket = bucketName();
    if (!c || !bucket) return Object.assign({}, EMPTY);
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const out = await c.send(new GetObjectCommand({ Bucket: bucket, Key: KEY }));
      const parsed = JSON.parse(await streamToString(out.Body));
      return {
        pocs: Array.isArray(parsed.pocs) ? parsed.pocs : [],
        activeOnly: parsed.activeOnly !== false,
        autoSync: parsed.autoSync !== false,
        lastSyncAt: parsed.lastSyncAt || null,
        lastSyncResult: parsed.lastSyncResult || null
      };
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return Object.assign({}, EMPTY);
      console.warn('[opsMktSyncRepo] load:', e.message);
      return Object.assign({}, EMPTY);
    }
  },

  async save(settings) {
    const c = getS3();
    const bucket = bucketName();
    if (!c || !bucket) return;
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await c.send(new PutObjectCommand({
      Bucket: bucket,
      Key: KEY,
      Body: JSON.stringify(Object.assign({}, EMPTY, settings, { updatedAt: new Date().toISOString() })),
      ContentType: 'application/json'
    }));
  }
};

module.exports = { OpsMktSyncRepo, EMPTY };

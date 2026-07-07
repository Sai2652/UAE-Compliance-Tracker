// Tracker state repo — clients + team members as one JSON blob in S3.
// Bucket: process.env.UCT_S3_BUCKET, Key: 'tracker_state.json'
//
// One-object storage is a perfect S3 fit and preserves the current
// tracker.saveData(clients, teamMembers) full-blob overwrite semantics
// exactly.

const { getS3, bucketName } = require('../aws');

const KEY = 'tracker_state.json';

function streamToString(stream) {
  return new Promise(function(resolve, reject) {
    const chunks = [];
    stream.on('data', function(c) { chunks.push(c); });
    stream.on('error', reject);
    stream.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

const TrackerStateRepo = {
  async load() {
    const c = getS3();
    const bucket = bucketName();
    if (!c || !bucket) return { clients: [], teamMembers: [] };
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const out = await c.send(new GetObjectCommand({ Bucket: bucket, Key: KEY }));
      const body = await streamToString(out.Body);
      const parsed = JSON.parse(body);
      return {
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        teamMembers: Array.isArray(parsed.teamMembers) ? parsed.teamMembers : []
      };
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
        return { clients: [], teamMembers: [] };
      }
      console.warn('[trackerStateRepo] load:', e.message);
      return { clients: [], teamMembers: [] };
    }
  },

  async save(clients, teamMembers, updatedBy) {
    const c = getS3();
    const bucket = bucketName();
    if (!c || !bucket) return;
    try {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const body = JSON.stringify({
        clients: clients || [],
        teamMembers: teamMembers || [],
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || null
      });
      await c.send(new PutObjectCommand({
        Bucket: bucket,
        Key: KEY,
        Body: body,
        ContentType: 'application/json'
      }));
    } catch (e) {
      console.warn('[trackerStateRepo] save:', e.message);
    }
  }
};

module.exports = { TrackerStateRepo };

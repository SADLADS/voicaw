// Creates the object store's buckets and makes them publicly readable (attachments are
// encrypted; profile pictures and guild icons are public on purpose). Used by s3.js at start.
//
// Stores without bucket policies (Garage) answer PutBucketPolicy with NotImplemented: their
// buckets are made public on the store itself instead (Garage's website access, served by
// nginx; see "Object store" in README.md), so that's not an error. Each bucket is set up on
// its own, so one failing doesn't leave the others undone.
const { CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');

// server/nginx/media.voicaw.com lets only these be read without a signature: a new bucket goes
// into its `$media_public_bucket` map too.
const BUCKETS = ['uploads', 'profile-pics', 'guild-icons', 'emojis', 'sounds'];

function publicReadPolicy(bucket) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${bucket}/*`],
    }],
  };
}

function isNotImplemented(err) {
  return err?.name === 'NotImplemented' || err?.Code === 'NotImplemented' || err?.$metadata?.httpStatusCode === 501;
}

async function ensureBucketExists(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err.name !== 'NotFound' && err.name !== 'NoSuchBucket') throw err;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

// Returns { failed: [bucket...], policies: true | false } (false: the store has no bucket
// policies). Failures are logged, not thrown: messaging works without the store, and the next
// start tries again.
async function setUpBuckets(client, { buckets = BUCKETS, log = console } = {}) {
  const failed = [];
  let policies = true;
  for (const bucket of buckets) {
    try {
      await ensureBucketExists(client, bucket);
      if (!policies) continue;
      try {
        await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(publicReadPolicy(bucket)) }));
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
        policies = false;
        log.info('Object store has no bucket policies: public reads are set up on the store itself (README "Object store").');
      }
    } catch (err) {
      failed.push(bucket);
      log.error('Failed to set up S3 bucket:', bucket, err.code || err.name, err.message);
    }
  }
  return { failed, policies };
}

module.exports = { setUpBuckets, publicReadPolicy, BUCKETS };

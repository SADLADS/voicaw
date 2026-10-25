const {
    S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CreateBucketCommand,
    HeadBucketCommand, PutBucketPolicyCommand, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
    CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
        accessKeyId: process.env.S3_ROOT_USER,
        secretAccessKey: process.env.S3_ROOT_PASSWORD,
    },
});

async function ensureBucketExists(bucketName) {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (err) {
        if (err.name === "NotFound" || err.name === "NoSuchBucket") {
            await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
        } else {
            throw err;
        }
    }
}

async function makeBucketPublic(bucketName) {
    const policy = {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: "*",
                Action: ["s3:GetObject"],
                Resource: [`arn:aws:s3:::${bucketName}/*`]
            }
        ]
    };

    await s3.send(new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: JSON.stringify(policy),
    }));
}


// `contentLength` is signed into the URL: the object store rejects an upload whose
// Content-Length differs, which is what enforces the server's size limits.
async function getUploadUrl(filename, bucket, contentType, contentLength) {
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: filename,
        ContentType: contentType,
        ContentLength: contentLength,
    });
    return await getSignedUrl(s3, command, {
        expiresIn: 60,
        signableHeaders: new Set(["content-type", "content-length"]),
    });
}

// Multipart uploads (big attachments, routes/uploads.js): started here, each part put by the
// client to its own pre-signed URL (its length signed in, as above), then put together here
// from what the store says it holds. Returns the upload id.
async function startMultipartUpload(bucket, key, contentType) {
    const res = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
    return res.UploadId;
}

// A URL for part `partNumber` (from 1), which must be `contentLength` bytes. Longer-lived than
// a whole upload's: parts are signed just before they're sent, but a slow phone sends three
// at a time.
async function getUploadPartUrl(bucket, key, uploadId, partNumber, contentLength) {
    const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
    });
    return await getSignedUrl(s3, command, {
        expiresIn: 300,
        signableHeaders: new Set(["content-length"]),
    });
}

// The parts the store has received: [{ PartNumber, Size, ETag }], in order.
async function listUploadedParts(bucket, key, uploadId) {
    const parts = [];
    let marker;
    do {
        const res = await s3.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
        parts.push(...(res.Parts ?? []));
        marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

async function completeMultipartUpload(bucket, key, uploadId, parts) {
    await s3.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) },
    }));
}

// Failures are logged, not thrown: the store drops unfinished uploads on its own after a day
// (MinIO's stale_uploads_expiry).
async function abortMultipartUpload(bucket, key, uploadId) {
    try {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
        console.error("Failed to abort upload:", bucket, key, err.code || err.name);
    }
}

// The buckets exist and are publicly readable (attachments are encrypted; profile pictures
// and guild icons are public on purpose). If the object store is unreachable, log it rather than crash the
// server: messaging works without it, and the next start tries again.
async function setUpBuckets() {
    for (const bucket of ["uploads", "profile-pics", "guild-icons", "emojis", "sounds"]) {
        await ensureBucketExists(bucket);
        await makeBucketPublic(bucket);
    }
}

setUpBuckets().catch((err) => console.error("Failed to set up S3 buckets:", err.code || err.name, err.message));

// Removes an object (e.g. a deleted custom emoji's image). Failures are logged, not thrown:
// the row is already gone, and a leftover file only takes space. Returns whether it worked
// (uploads.js tries again later).
async function deleteObject(bucket, key) {
    try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (err) {
        console.error("Failed to delete object:", bucket, key, err.code || err.name);
        return false;
    }
}

// An object's contents, as a Buffer.
async function getObject(bucket, key) {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
}

async function putObject(bucket, key, body, contentType) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// The keys directly in `bucket` (not in "folders": nothing after a '/'), up to 1000.
async function listTopLevelKeys(bucket) {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Delimiter: '/' }));
    return (res.Contents ?? []).map((object) => object.Key);
}

module.exports = {
    s3, getUploadUrl, getObject, putObject, deleteObject, listTopLevelKeys,
    startMultipartUpload, getUploadPartUrl, listUploadedParts, completeMultipartUpload, abortMultipartUpload,
};

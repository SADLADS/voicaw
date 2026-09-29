const { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand } = require("@aws-sdk/client-s3");
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

// The buckets exist and are publicly readable (attachments are encrypted; profile pictures
// and guild icons are public on purpose). If the object store is unreachable, log it rather than crash the
// server: messaging works without it, and the next start tries again.
async function setUpBuckets() {
    for (const bucket of ["uploads", "profile-pics", "guild-icons"]) {
        await ensureBucketExists(bucket);
        await makeBucketPublic(bucket);
    }
}

setUpBuckets().catch((err) => console.error("Failed to set up S3 buckets:", err.code || err.name, err.message));

module.exports = { s3, getUploadUrl };

const { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand } = require("@aws-sdk/client-s3");
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

// Generate a pre-signed download URL
async function getDownloadUrl(filename) {
    const command = new GetObjectCommand({
        Bucket: "uploads",
        Key: filename,
    });
    return await getSignedUrl(s3, command, { expiresIn: 60 });
}

ensureBucketExists("uploads")
ensureBucketExists("profile-pics")
makeBucketPublic("profile-pics")
makeBucketPublic("uploads")

module.exports = { s3, getUploadUrl, getDownloadUrl };
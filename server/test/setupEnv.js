import opaque from '@serenity-kit/opaque';
import webpush from 'web-push';

await opaque.ready;

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
process.env.MAX_MESSAGE_LENGTH = '5000';
process.env.S3_ENDPOINT = 'http://localhost:0';
process.env.S3_ROOT_USER = 'test-root-user';
process.env.S3_ROOT_PASSWORD = 'test-root-password';

const vapidKeys = webpush.generateVAPIDKeys();
process.env.VAPID_EMAIL = 'mailto:test@example.com';
process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;

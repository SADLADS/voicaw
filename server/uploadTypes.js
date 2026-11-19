// What an object in the store may be served as (security audit, 2026-11-18). Every bucket is
// read publicly at media.voicaw.com, with the Content-Type signed into its upload: a type a
// browser renders as a page (text/html, image/svg+xml, anything XML) would be a live page,
// script included, on one of our own names. So uploads are signed only for these.

// Pictures browsers show and can't run script in.
const PICTURE_TYPE = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/;
// Anything that may be stored: opaque (encrypted attachments), pictures, sound and video.
const SERVABLE_TYPE = /^(?:application\/octet-stream|image\/(?:png|jpeg|gif|webp|avif|bmp)|(?:audio|video)\/[a-z0-9.+-]+)$/;

const isPictureType = (type) => typeof type === 'string' && PICTURE_TYPE.test(type);
const isServableType = (type) => typeof type === 'string' && SERVABLE_TYPE.test(type) && !type.includes('xml');

module.exports = { isPictureType, isServableType };

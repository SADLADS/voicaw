// Our own tracking parameters, in utils/linkCleaner.js's rule format: always used with the
// server's downloaded list (server/linkRules.js), and alone when there's none (offline, a server
// that doesn't have it, an admin turned it off). Written for Voicaw, not copied from that list,
// so it can be bundled with the app; keep it short and certain, since the downloaded list does
// the rest. KEEP wins over both: parameters people mean to share.

const everywhere = (names) => names.map((p) => ({ p }));
const on = (hosts, names) => names.map((p) => ({ p, h: hosts }));

export const BUILT_IN_RULES = [
  // Campaign and ad-click tags (Google Analytics, Google, Meta, Microsoft, Yandex, TikTok,
  // X, Mailchimp, HubSpot, Marketo, Instagram...).
  { p: '/^utm_/' },
  ...everywhere(['fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'ttclid', 'twclid',
    'igshid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', '_gl']),
  // X / Twitter's share links (`?s=20&t=...`).
  ...on(['x.com', 'twitter.com'], ['s', 't', 'a', 'ref_src', 'ref_url']),
  // YouTube's share id and where you were on YouTube.
  ...on(['youtube.com', 'youtu.be'], ['si', 'pp', 'feature']),
  ...on(['open.spotify.com'], ['si']),
  ...on(['instagram.com'], ['igsh']),
  ...on(['tiktok.com'], ['_r', '_t', 'is_from_webapp', 'sender_device', 'is_copy_url']),
  ...on(['reddit.com'], ['share_id', 'rdt']),
  ...on(['facebook.com'], ['mibextid', 'rdid', 'sfnsn']),
  ...on(['linkedin.com'], ['trk', 'trackingId', 'lipi']),
];

export const KEEP_RULES = [
  // A YouTube link's video, start time, playlist and place in it.
  ...['v', 't', 'list', 'index', 'start'].map((p) => ({ p, h: ['youtube.com', 'youtu.be'], e: 1 })),
];

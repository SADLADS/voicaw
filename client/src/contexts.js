import { createContext } from 'react';

// App-wide contexts, in their own module so component files only export components (which
// keeps Vite's hot reload working).

// Server settings from /api/config (App).
export const ConfigContext = createContext({
  s3Endpoint: '',
  maxPlaintextLength: 5000,
});

// Desktop or mobile interaction (App): chosen in Settings, or detected ("auto").
export const InteractionContext = createContext({
  interactionMode: 'auto',
  isMobile: false,
  setInteractionMode: () => { },
});

// The logged-in layout's shared data (Layout): users list, unread counts.
export const LayoutContext = createContext();

// Opens the full-screen image viewer (ImageViewerProvider): `openImage({ images, index })`,
// gallery items from utils/imageGallery.js. Null outside the provider (e.g. in component tests).
export const ImageViewerContext = createContext(null);

// Guild channels that `<#id>` mentions name (Layout): `channels` ({ id: { id, guildId, name,
// type, private } }: every channel you can see in the guilds opened so far) and `loadAll()`,
// which opens the rest of your guilds (once) when a mention names a channel not known yet.
// Opening them all, rather than asking about that one channel, keeps the server from learning
// which channel an encrypted message named. Null outside Layout.
export const ChannelMentionContext = createContext(null);

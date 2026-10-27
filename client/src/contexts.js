import { createContext } from 'react';

// App-wide contexts, in their own module so component files only export components (which
// keeps Vite's hot reload working).

// Server settings from /api/config (App).
export const ConfigContext = createContext({
  s3Endpoint: '',
  maxPlaintextLength: 5000,
});

// Desktop or mobile interaction (App), detected from the device.
export const InteractionContext = createContext({ isMobile: false });

// The logged-in layout's shared data (Layout): you (`user`), users list, unread counts.
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

// Whether what's drawn inside is from an NSFW guild channel (GuildView, GuildSearch): its media
// is covered until clicked, unless Settings turns that off (hooks/useMediaCover.js).
export const NsfwChannelContext = createContext(false);

// Threads of the guild text channel on screen (GuildView): `openThread(threadId)` shows one
// beside the channel, `createThread(msg)` asks for a name and starts one from a message (null
// when you can't start threads there), `startThread()` one on its own (the message box's +;
// null the same way), `showThreads()` opens the channel's thread list.
export const ThreadContext = createContext(null);

// The guild on screen, for a person's card opened from a name or picture in its chats
// (ProfilePopover shows guild/MemberCard for its members): { guild, members, user, userApps,
// onRunUserApp } (GuildView). Null elsewhere (DMs, group DMs).
export const GuildMembersContext = createContext(null);

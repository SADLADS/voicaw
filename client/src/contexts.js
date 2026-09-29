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

// Opens the full-screen image viewer (ImageViewerProvider): `openImage({ src, name, size,
// width, height })`. Null outside the provider (e.g. in component tests).
export const ImageViewerContext = createContext(null);

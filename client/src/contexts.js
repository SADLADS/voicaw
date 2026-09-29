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

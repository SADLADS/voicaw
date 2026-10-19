import React from 'react';
import ReactDOM from 'react-dom/client';
import '../assets/css/voicaw.css';
import '../assets/css/overlay.css';
import Overlay from './Overlay';

// The desktop app's in-game overlay page (overlay.html, electron/overlay.js): drawn from what
// the app sends it (window.voicawOverlay, electron/overlayPreload.js), nothing else.
ReactDOM.createRoot(document.getElementById('root')).render(<Overlay bridge={window.voicawOverlay} />);

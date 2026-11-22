// UI5 web components need the DOM (customElements, window) at import time, so the app renders
// client-side only. Remote functions and +server routes still run on the server.
export const ssr = false;

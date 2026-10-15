/**
 * True for the build published as a Claude artifact (`npm run build:artifact`). That viewer runs the
 * app in a sandboxed frame: no file downloads, no service worker and no URL routing.
 */
export const IS_ARTIFACT = import.meta.env.MODE === 'artifact';

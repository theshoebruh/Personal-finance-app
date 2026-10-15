import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Offline support and update prompt. A new version is only activated when the user agrees, so an
 * update never reloads the page in the middle of editing.
 */
export function UpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!offlineReady && !needRefresh) return null;
  return (
    <div className="status-toast" role="status">
      <div className="alert alert-info">
        <span className="alert-icon" aria-hidden="true">
          i
        </span>
        <div className="stack">
          <p>
            {needRefresh
              ? 'A new version of the app is available.'
              : 'The app is ready to work offline on this device.'}
          </p>
          <div className="btn-row">
            {needRefresh && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void updateServiceWorker(true)}
              >
                Update now
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setOfflineReady(false);
                setNeedRefresh(false);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

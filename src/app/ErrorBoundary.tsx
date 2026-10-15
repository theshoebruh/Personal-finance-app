import { Component, type ReactNode } from 'react';

/** Last-resort screen, e.g. when the browser blocks local storage (private mode, blocked site data). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="main">
        <div className="card stack">
          <h1>The app couldn’t start</h1>
          <p>
            It stores your data in this browser, and the browser refused or failed to open that
            storage. This happens in private windows, or when site data is blocked or full.
          </p>
          <p className="small muted">Details: {this.state.error.message}</p>
          <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </main>
    );
  }
}

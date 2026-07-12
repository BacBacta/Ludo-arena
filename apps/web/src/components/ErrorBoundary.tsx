/**
 * Top-level error boundary. A render throw inside MiniPay's webview otherwise
 * leaves a permanent white screen with no recovery; this shows a friendly
 * fallback with a reload button and logs the error for diagnostics.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../lib/i18n';

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep it to console for now; a real error tracker (Sentry) plugs in here.
    console.error('[app] render crash', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <div className="crash__emoji" aria-hidden="true">😵‍💫</div>
          <div className="crash__title">{t('crashTitle')}</div>
          <div className="crash__sub">{t('crashSub')}</div>
          <button className="btn" onClick={() => window.location.reload()}>
            {t('reload')}
          </button>
        </div>
      </div>
    );
  }
}

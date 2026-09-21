import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryState = {
  failed: boolean;
};

export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("DuduHire page render failed", error, errorInfo);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main id="main" className="auth-main">
        <section className="auth-redirect" role="alert">
          <h1>页面暂时无法加载</h1>
          <p>你可以重新加载页面；如果问题仍然存在，请返回首页继续浏览。</p>
          <div>
            <a className="button button-primary" href={window.location.href}>重新加载</a>
            <a href="/">返回首页</a>
          </div>
        </section>
      </main>
    );
  }
}

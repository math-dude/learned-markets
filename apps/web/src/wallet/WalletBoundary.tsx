import { Component, type ReactNode } from 'react'

export class WalletBoundary extends Component<{ children: ReactNode; market: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <>
        <div role="alert" className="paper-warning">
          The wallet dialog closed unexpectedly.{' '}
          <button className="pill-btn" onClick={() => this.setState({ failed: false })}>
            Reconnect wallet
          </button>
        </div>
        {this.props.market}
      </>
    )
  }
}

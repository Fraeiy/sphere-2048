import { Component } from 'react'

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100vw', height: '100vh', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: '#1a1a2e', color: '#edc22e', flexDirection: 'column',
          gap: '16px', fontFamily: 'Arial', textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '2rem' }}>Sphere 2048</h2>
          <p style={{ color: '#aaa', maxWidth: '400px' }}>
            WebGL is required to run this game. Please use a browser that supports WebGL.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

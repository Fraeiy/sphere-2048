import { Canvas } from '@react-three/fiber'
import { useGame } from './hooks/useGame'
import { GameSphere } from './components/GameSphere'
import { HUD } from './components/HUD'
import { ErrorBoundary } from './components/ErrorBoundary'
import './App.css'

function App() {
  const { tiles, score, best, gameOver, won, positions, move, restart } = useGame()

  return (
    <div className="app">
      <ErrorBoundary>
        <Canvas
          camera={{ position: [0, 0, 3.5], fov: 60 }}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
          gl={{ antialias: true }}
          onCreated={({ gl }) => {
            gl.setClearColor('#1a1a2e')
          }}
        >
          <GameSphere
            tiles={tiles}
            positions={positions}
            autoRotate={false}
          />
        </Canvas>
      </ErrorBoundary>
      <HUD
        score={score}
        best={best}
        gameOver={gameOver}
        won={won}
        onMove={move}
        onRestart={restart}
      />
    </div>
  )
}

export default App

import './HUD.css'

export function HUD({ score, best, gameOver, won, onMove, onRestart }) {
  return (
    <div className="hud">
      <div className="hud-top">
        <div className="title-area">
          <h1 className="title">Sphere 2048</h1>
          <p className="subtitle">Rotate the sphere. Tap to merge!</p>
        </div>
        <div className="scores">
          <div className="score-box">
            <span className="score-label">SCORE</span>
            <span className="score-value">{score}</span>
          </div>
          <div className="score-box">
            <span className="score-label">BEST</span>
            <span className="score-value">{best}</span>
          </div>
        </div>
      </div>

      <div className="hud-bottom">
        <button className="btn btn-merge" onClick={onMove} disabled={gameOver}>
          Merge Tiles
        </button>
        <button className="btn btn-new" onClick={onRestart}>
          New Game
        </button>
      </div>

      {(gameOver || won) && (
        <div className="overlay">
          <div className="overlay-box">
            <h2>{won ? '🎉 You Win!' : 'Game Over'}</h2>
            <p>{won ? 'You reached 2048!' : 'No more moves!'}</p>
            <button className="btn btn-new" onClick={onRestart}>
              Play Again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

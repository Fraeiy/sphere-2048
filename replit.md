# Sphere 2048

A 3D take on the classic 2048 game — tiles are placed on a rotating sphere using React Three Fiber and Three.js.

## Architecture

- **Framework**: React 18 + Vite
- **3D Engine**: Three.js via @react-three/fiber and @react-three/drei
- **Language**: JavaScript (JSX)
- **Port**: 5000

## Project Structure

```
src/
  App.jsx               # Root component
  App.css               # App-level styles
  index.css             # Global reset styles
  main.jsx              # Entry point
  components/
    GameSphere.jsx      # Three.js Canvas + OrbitControls
    SphereTile.jsx      # Individual tile rendered on sphere surface
    HUD.jsx             # Score, buttons, game over overlay
    HUD.css             # HUD styles
    ErrorBoundary.jsx   # WebGL fallback
  hooks/
    useGame.js          # Game state management
  utils/
    gameLogic.js        # Tile positions, adjacency, merge logic
```

## Game Mechanics

- 20 tiles are positioned on a sphere using the Fibonacci/golden angle distribution
- Adjacency between tiles is computed by nearest-neighbor (k=4)
- "Merge Tiles" button triggers one merge round: adjacent tiles of equal value merge
- After each merge, a new random tile (2 or 4) is added
- Game ends when no merges are possible and the sphere is full
- Goal: reach the 2048 tile

## Running

```
npm run dev
```

## Deployment

Configured as a static site deployment (Vite build → `dist/` folder).

// Fibonacci-like positions on a sphere using golden angle
export function generateSpherePositions(count) {
  const positions = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = goldenAngle * i
    positions.push([
      radius * Math.cos(theta),
      y,
      radius * Math.sin(theta)
    ])
  }
  return positions
}

// Tile values and their colors
export const TILE_COLORS = {
  2:    { bg: '#eee4da', text: '#776e65' },
  4:    { bg: '#ede0c8', text: '#776e65' },
  8:    { bg: '#f2b179', text: '#f9f6f2' },
  16:   { bg: '#f59563', text: '#f9f6f2' },
  32:   { bg: '#f67c5f', text: '#f9f6f2' },
  64:   { bg: '#f65e3b', text: '#f9f6f2' },
  128:  { bg: '#edcf72', text: '#f9f6f2' },
  256:  { bg: '#edcc61', text: '#f9f6f2' },
  512:  { bg: '#edc850', text: '#f9f6f2' },
  1024: { bg: '#edc53f', text: '#f9f6f2' },
  2048: { bg: '#edc22e', text: '#f9f6f2' },
}

export function getTileColor(value) {
  return TILE_COLORS[value] || { bg: '#3c3a32', text: '#f9f6f2' }
}

// Convert hex color to THREE.js color number
export function hexToThreeColor(hex) {
  return parseInt(hex.replace('#', '0x'), 16)
}

// Number of tiles on the sphere
export const TILE_COUNT = 20

// Initialize game state
export function initGame() {
  const tiles = Array(TILE_COUNT).fill(null)
  const state = { tiles, score: 0, best: 0, gameOver: false, won: false }
  addRandomTile(state)
  addRandomTile(state)
  return state
}

// Get empty positions
export function getEmptyPositions(tiles) {
  return tiles.map((v, i) => v === null ? i : -1).filter(i => i !== -1)
}

// Add a random tile (2 or 4) to an empty spot
export function addRandomTile(state) {
  const empty = getEmptyPositions(state.tiles)
  if (empty.length === 0) return
  const idx = empty[Math.floor(Math.random() * empty.length)]
  state.tiles[idx] = Math.random() < 0.9 ? 2 : 4
}

// Find nearest neighbor pairs (precomputed adjacency)
export function computeAdjacency(positions, k = 4) {
  const adj = positions.map(() => [])
  for (let i = 0; i < positions.length; i++) {
    const dists = []
    for (let j = 0; j < positions.length; j++) {
      if (i === j) continue
      const dx = positions[i][0] - positions[j][0]
      const dy = positions[i][1] - positions[j][1]
      const dz = positions[i][2] - positions[j][2]
      dists.push({ j, d: dx * dx + dy * dy + dz * dz })
    }
    dists.sort((a, b) => a.d - b.d)
    adj[i] = dists.slice(0, k).map(x => x.j)
  }
  return adj
}

// Perform a merge sweep: pick random non-merged tile and merge with a neighbor
export function doMove(state, adjacency) {
  const tiles = [...state.tiles]
  let merged = false
  let gained = 0

  // Try to find mergeable pairs
  const candidates = []
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === null) continue
    for (const j of adjacency[i]) {
      if (tiles[j] === tiles[i]) {
        candidates.push([i, j])
      }
    }
  }

  if (candidates.length > 0) {
    const mergedSet = new Set()
    for (const [i, j] of candidates) {
      if (mergedSet.has(i) || mergedSet.has(j)) continue
      const newVal = tiles[i] * 2
      tiles[i] = newVal
      tiles[j] = null
      gained += newVal
      mergedSet.add(i)
      mergedSet.add(j)
      merged = true
    }
  } else {
    // No merges possible - shift tiles toward center (compact empty spaces)
    // Shuffle tiles to simulate a "swipe"
    const nonNull = tiles.map((v, i) => ({ v, i })).filter(x => x.v !== null)
    for (let k = 0; k < tiles.length; k++) tiles[k] = null
    nonNull.forEach((item, k) => { tiles[k] = item.v })
  }

  const newScore = state.score + gained
  const best = Math.max(state.best, newScore)
  const won = tiles.some(v => v >= 2048)
  const gameOver = !merged && getEmptyPositions(tiles).length === 0 && !hasMergeAvailable(tiles, adjacency)

  return { tiles, score: newScore, best, gameOver, won }
}

export function hasMergeAvailable(tiles, adjacency) {
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === null) continue
    for (const j of adjacency[i]) {
      if (tiles[j] === tiles[i] || tiles[j] === null) return true
    }
  }
  return false
}

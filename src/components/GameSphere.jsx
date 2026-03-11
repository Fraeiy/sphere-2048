import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { SphereTile } from './SphereTile'

export function GameSphere({ tiles, positions, autoRotate = false }) {
  const groupRef = useRef()

  useFrame((state, delta) => {
    if (autoRotate && groupRef.current) {
      groupRef.current.rotation.y += delta * 0.3
    }
  })

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} />
      <pointLight position={[-5, -5, -5]} intensity={0.3} color="#4488ff" />

      <group ref={groupRef}>
        {/* Main sphere */}
        <mesh>
          <sphereGeometry args={[1, 64, 64]} />
          <meshStandardMaterial
            color="#16213e"
            roughness={0.3}
            metalness={0.6}
          />
        </mesh>

        {/* Tiles */}
        {tiles.map((value, idx) =>
          value !== null ? (
            <SphereTile
              key={idx}
              position={positions[idx]}
              value={value}
              radius={1.05}
              isNew={false}
            />
          ) : null
        )}
      </group>

      <OrbitControls
        enableZoom={true}
        enablePan={false}
        minDistance={2}
        maxDistance={6}
        rotateSpeed={0.5}
      />
    </>
  )
}

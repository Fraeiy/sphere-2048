import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text, Sphere } from '@react-three/drei'
import * as THREE from 'three'
import { getTileColor, hexToThreeColor } from '../utils/gameLogic'

export function SphereTile({ position, value, radius = 1.05, isNew = false }) {
  const meshRef = useRef()
  const [scale, setScale] = useState(isNew ? 0.1 : 1)
  const color = getTileColor(value)
  const bgColor = hexToThreeColor(color.bg)
  const textColor = color.text

  useFrame((state, delta) => {
    if (scale < 1) {
      setScale(prev => Math.min(1, prev + delta * 8))
    }
    if (meshRef.current) {
      meshRef.current.scale.setScalar(scale)
    }
  })

  const [x, y, z] = position
  // Position tile on sphere surface
  const norm = Math.sqrt(x * x + y * y + z * z)
  const nx = x / norm * radius
  const ny = y / norm * radius
  const nz = z / norm * radius

  // Rotation to face outward
  const outward = new THREE.Vector3(x, y, z).normalize()
  const quaternion = new THREE.Quaternion()
  quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward)

  return (
    <group position={[nx, ny, nz]} quaternion={quaternion} ref={meshRef}>
      <mesh>
        <circleGeometry args={[0.12, 32]} />
        <meshStandardMaterial color={bgColor} />
      </mesh>
      <Text
        position={[0, 0, 0.001]}
        fontSize={value >= 1000 ? 0.04 : 0.055}
        color={textColor}
        anchorX="center"
        anchorY="middle"
        font={undefined}
      >
        {value}
      </Text>
    </group>
  )
}

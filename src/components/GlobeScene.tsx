"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { GLOBE_POINTS, generateArcs, latLngToVec3 } from "./GlobeData";

const RADIUS = 2;
const ARC_SEGMENTS = 64;

/** Creates a curved arc between two points on the sphere */
function createArcCurve(
  start: [number, number, number],
  end: [number, number, number]
): THREE.CubicBezierCurve3 {
  const mid = new THREE.Vector3()
    .addVectors(new THREE.Vector3(...start), new THREE.Vector3(...end))
    .multiplyScalar(0.5)
    .normalize()
    .multiplyScalar(RADIUS * 1.35);

  return new THREE.CubicBezierCurve3(
    new THREE.Vector3(...start),
    mid.clone().lerp(new THREE.Vector3(...start), 0.25),
    mid.clone().lerp(new THREE.Vector3(...end), 0.25),
    new THREE.Vector3(...end)
  );
}

export default function GlobeScene() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((_state, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.08;
    }
  });

  const arcPoints = useMemo(() => {
    const arcs = generateArcs(8);
    return arcs.map((arc) => {
      const start = latLngToVec3(arc.start.lat, arc.start.lng, RADIUS);
      const end = latLngToVec3(arc.end.lat, arc.end.lng, RADIUS);
      const curve = createArcCurve(start, end);
      return curve.getPoints(ARC_SEGMENTS).map((p) => [p.x, p.y, p.z] as [number, number, number]);
    });
  }, []);

  const dotPositions = useMemo(() => {
    return GLOBE_POINTS.map((p) => latLngToVec3(p.lat, p.lng, RADIUS));
  }, []);

  return (
    <group ref={groupRef} rotation={[0.3, -0.5, 0.1]}>
      {/* Wireframe sphere */}
      <mesh>
        <sphereGeometry args={[RADIUS, 48, 48]} />
        <meshBasicMaterial color="#c43c4c" wireframe transparent opacity={0.08} />
      </mesh>

      {/* Outer glow sphere */}
      <mesh>
        <sphereGeometry args={[RADIUS * 1.01, 48, 48]} />
        <meshBasicMaterial color="#c43c4c" transparent opacity={0.03} />
      </mesh>

      {/* Longitude / latitude grid */}
      <mesh>
        <sphereGeometry args={[RADIUS * 0.998, 24, 24]} />
        <meshBasicMaterial color="#c43c4c" wireframe transparent opacity={0.04} />
      </mesh>

      {/* Connection arcs */}
      {arcPoints.map((pts, i) => (
        <Line key={`arc-${i}`} points={pts} color="#c43c4c" transparent opacity={0.4} lineWidth={1} />
      ))}

      {/* City dots */}
      {dotPositions.map((pos, i) => (
        <mesh key={`dot-${i}`} position={pos}>
          <sphereGeometry args={[0.025, 8, 8]} />
          <meshBasicMaterial color="#e85d6d" />
        </mesh>
      ))}
    </group>
  );
}

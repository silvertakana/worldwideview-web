"use client";

import { Canvas } from "@react-three/fiber";
import GlobeScene from "./GlobeScene";

export default function GlobeCanvas() {
  return (
    <Canvas
      camera={{ position: [0, 0, 5.5], fov: 45 }}
      style={{ width: "100%", height: "100%" }}
      gl={{ alpha: true, antialias: true }}
    >
      <ambientLight intensity={0.5} />
      <GlobeScene />
    </Canvas>
  );
}

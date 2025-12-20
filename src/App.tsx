import { useState, useMemo, useRef, useEffect, Suspense, useCallback } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles,
  useTexture
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

// --- 动态生成照片列表 (top.jpg + 1.jpg 到 31.jpg) ---
const TOTAL_NUMBERED_PHOTOS = 31;
// 修改：将 top.jpg 加入到数组开头
const bodyPhotoPaths = [
  '/photos/top.jpg',
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => `/photos/${i + 1}.jpg`)
];

// --- 视觉配置 ---
const CONFIG = {
  colors: {
    emerald: '#004225', // 纯正祖母绿
    gold: '#FFD700',
    silver: '#ECEFF1',
    red: '#D32F2F',
    green: '#2E7D32',
    white: '#FFFFFF',   // 纯白色
    warmLight: '#FFD54F',
    lights: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'], // 彩灯
    // 拍立得边框颜色池 (复古柔和色系)
    borders: ['#FFFAF0', '#F0E68C', '#E6E6FA', '#FFB6C1', '#98FB98', '#87CEFA', '#FFDAB9'],
    // 圣诞元素颜色
    giftColors: ['#D32F2F', '#FFD700', '#1976D2', '#2E7D32'],
    candyColors: ['#FF0000', '#FFFFFF']
  },
  counts: {
    foliage: 12000,   // 优化粒子数量以提升性能
    ornaments: 200,   // 优化照片数量以提升性能
    elements: 500,    // 增加圣诞元素数量填充底部
    lights: 800       // 增加彩灯数量填充底部
  },
  tree: { height: 32, radius: 13 }, // 增大树的尺寸 (从22x9增加到32x13)
  photos: {
    // top 属性不再需要，因为已经移入 body
    body: bodyPhotoPaths
  }
};

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(CONFIG.colors.emerald), uProgress: 0 },
  `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
  `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = CONFIG.tree.height; const rBase = CONFIG.tree.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Foliage ---
const Foliage = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const materialRef = useRef<any>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const count = CONFIG.counts.foliage;
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, []);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
  });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
        <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
      </bufferGeometry>
      {/* @ts-ignore */}
      <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

// --- Component: Photo Ornaments (Double-Sided Polaroid) ---
const PhotoOrnaments = ({ state, onPhotoClick, groupRef, hoveredIndex }: { state: 'CHAOS' | 'FORMED', onPhotoClick: (index: number) => void, groupRef: React.RefObject<THREE.Group>, hoveredIndex: number | null }) => {
  const textures = useTexture(CONFIG.photos.body);
  const count = CONFIG.counts.ornaments;
  const internalGroupRef = useRef<THREE.Group>(null);

  // 使用传入的 ref 或内部 ref
  const actualGroupRef = groupRef || internalGroupRef;

  const borderGeometry = useMemo(() => new THREE.PlaneGeometry(1.2, 1.5), []);
  const photoGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map((_, i) => {
      // 让Y轴分布更偏向底部（更小的负Y值），使用大于1的幂次让更多值靠近0（对应yPos=-35底部）
      // yRandom范围0-1，映射到-35到35，让更多值靠近0（底部）
      const yRandom = Math.pow(Math.random(), 2.0); // 使用大于1的幂次，让更多值靠近0（底部密集）
      const yPos = -35 + yRandom * 70; // -35（底部）到35（顶部），更多在-35附近
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*70, yPos, (Math.random()-0.5)*70);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.5;
      const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      // 树形状态：照片更小
      const formedScale = 0.3 + Math.random() * 0.2; // 0.3-0.5 很小

      // CHAOS状态：根据Z轴深度计算大小，越靠前（z越大）越大
      const depthFactor = (chaosPos.z + 35) / 70; // 归一化到0-1，越靠前越大
      const chaosScale = 1.2 + depthFactor * 2.5; // 1.2-3.7 范围，前面的图片更大

      const weight = 0.8 + Math.random() * 1.2;
      const borderColor = CONFIG.colors.borders[Math.floor(Math.random() * CONFIG.colors.borders.length)];

      const rotationSpeed = {
        x: (Math.random() - 0.5) * 1.0,
        y: (Math.random() - 0.5) * 1.0,
        z: (Math.random() - 0.5) * 1.0
      };
      const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

      return {
        chaosPos, targetPos, formedScale, chaosScale, weight,
        textureIndex: i % textures.length,
        borderColor,
        currentPos: chaosPos.clone(),
        chaosRotation,
        rotationSpeed,
        wobbleOffset: Math.random() * 10,
        wobbleSpeed: 0.5 + Math.random() * 0.5
      };
    });
  }, [textures, count]);

  useFrame((stateObj, delta) => {
    if (!actualGroupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;

    actualGroupRef.current.children.forEach((group, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;

      objData.currentPos.lerp(target, delta * (isFormed ? 0.8 * objData.weight : 0.5));
      group.position.copy(objData.currentPos);

      if (isFormed) {
         const targetLookPos = new THREE.Vector3(group.position.x * 2, group.position.y + 0.5, group.position.z * 2);
         group.lookAt(targetLookPos);

         const wobbleX = Math.sin(time * objData.wobbleSpeed + objData.wobbleOffset) * 0.05;
         const wobbleZ = Math.cos(time * objData.wobbleSpeed * 0.8 + objData.wobbleOffset) * 0.05;
         group.rotation.x += wobbleX;
         group.rotation.z += wobbleZ;

      } else {
         group.rotation.x += delta * objData.rotationSpeed.x;
         group.rotation.y += delta * objData.rotationSpeed.y;
         group.rotation.z += delta * objData.rotationSpeed.z;
      }
    });
  });

  return (
    <group ref={actualGroupRef}>
      {data.map((obj, i) => {
        const currentScale = state === 'CHAOS' ? obj.chaosScale : obj.formedScale;
        return (
        <group
          key={i}
          scale={[currentScale, currentScale, currentScale]}
          rotation={state === 'CHAOS' ? obj.chaosRotation : [0,0,0]}
          onClick={(e) => {
            e.stopPropagation();
            onPhotoClick(obj.textureIndex);
          }}
        >
          {/* 正面 */}
          <group position={[0, 0, 0.015]}>
            <mesh geometry={photoGeometry}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={hoveredIndex === i ? CONFIG.colors.gold : CONFIG.colors.white}
                emissiveMap={textures[obj.textureIndex]}
                emissiveIntensity={hoveredIndex === i ? 1.5 : 1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
              <meshStandardMaterial
                color={hoveredIndex === i ? CONFIG.colors.gold : obj.borderColor}
                roughness={0.9}
                metalness={0}
                side={THREE.FrontSide}
              />
            </mesh>
          </group>
          {/* 背面 */}
          <group position={[0, 0, -0.015]} rotation={[0, Math.PI, 0]}>
            <mesh geometry={photoGeometry}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={hoveredIndex === i ? CONFIG.colors.gold : CONFIG.colors.white}
                emissiveMap={textures[obj.textureIndex]}
                emissiveIntensity={hoveredIndex === i ? 1.5 : 1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
              <meshStandardMaterial
                color={hoveredIndex === i ? CONFIG.colors.gold : obj.borderColor}
                roughness={0.9}
                metalness={0}
                side={THREE.FrontSide}
              />
            </mesh>
          </group>
        </group>
        )
      })}
    </group>
  );
};

// --- Component: Christmas Elements ---
const ChristmasElements = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.elements;
  const groupRef = useRef<THREE.Group>(null);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(0.8, 0.8, 0.8), []);
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(0.5, 16, 16), []);
  const caneGeometry = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      // 让Y轴分布更偏向底部（更小的负Y值），使用大于1的幂次让更多值靠近0（对应yPos=-30底部）
      // yRandom范围0-1，映射到-30到30，让更多值靠近0（底部）
      const yRandom = Math.pow(Math.random(), 2.0); // 使用大于1的幂次，让更多值靠近0（底部密集）
      const yPos = -30 + yRandom * 60; // -30（底部）到30（顶部），更多在-30附近
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, yPos, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height;
      const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) * 0.95;
      const theta = Math.random() * Math.PI * 2;

      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const type = Math.floor(Math.random() * 3);
      let color; let scale = 1;
      if (type === 0) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.8 + Math.random() * 0.4; }
      else if (type === 1) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.6 + Math.random() * 0.4; }
      else { color = Math.random() > 0.5 ? CONFIG.colors.red : CONFIG.colors.white; scale = 0.7 + Math.random() * 0.3; }

      const rotationSpeed = { x: (Math.random()-0.5)*2.0, y: (Math.random()-0.5)*2.0, z: (Math.random()-0.5)*2.0 };
      return { type, chaosPos, targetPos, color, scale, currentPos: chaosPos.clone(), chaosRotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI), rotationSpeed };
    });
  }, [boxGeometry, sphereGeometry, caneGeometry]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    groupRef.current.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh;
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 1.5);
      mesh.position.copy(objData.currentPos);
      mesh.rotation.x += delta * objData.rotationSpeed.x; mesh.rotation.y += delta * objData.rotationSpeed.y; mesh.rotation.z += delta * objData.rotationSpeed.z;
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => {
        let geometry; if (obj.type === 0) geometry = boxGeometry; else if (obj.type === 1) geometry = sphereGeometry; else geometry = caneGeometry;
        return ( <mesh key={i} scale={[obj.scale, obj.scale, obj.scale]} geometry={geometry} rotation={obj.chaosRotation}>
          <meshStandardMaterial color={obj.color} roughness={0.3} metalness={0.4} emissive={obj.color} emissiveIntensity={0.2} />
        </mesh> )})}
    </group>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.lights;
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      // 让Y轴分布更偏向底部（更小的负Y值），使用大于1的幂次让更多值靠近0（对应yPos=-30底部）
      // yRandom范围0-1，映射到-30到30，让更多值靠近0（底部）
      const yRandom = Math.pow(Math.random(), 2.0); // 使用大于1的幂次，让更多值靠近0（底部密集）
      const yPos = -30 + yRandom * 60; // -30（底部）到30（顶部），更多在-30附近
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, yPos, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2); const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = CONFIG.colors.lights[Math.floor(Math.random() * CONFIG.colors.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, []);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh;
      mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
    </group>
  );
};

// --- Component: Unified Particle Effect (for both tree forming and photo viewing) ---
const ParticleEffect = ({ triggerTreeForm, isPhotoOpen, opacity = 1.0 }: { triggerTreeForm: boolean, isPhotoOpen: boolean, opacity?: number }) => {
  const particlesRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const particleBatchesRef = useRef<Array<{
    launchPos: Float32Array,
    explosionPos: Float32Array,
    velocities: Float32Array,
    colors: Float32Array,
    explosionTime: Float32Array,
    lifetime: number,
    startTime: number,
    isFirework: boolean
  }>>([]);
  const nextSpawnTime = useRef<number>(0);
  const [isActive, setIsActive] = useState(false);
  const startTime = useRef<number>(0);

  const createFirework = useCallback((isPhotoMode: boolean) => {
    const count = isPhotoMode ? 400 : 600; // 照片模式增加粒子数量

    // 发射阶段：从图片周围或底部向外发射
    const launchX = isPhotoMode ? (Math.random() - 0.5) * 20 : (Math.random() - 0.5) * 30;
    const launchY = isPhotoMode ? 5 + (Math.random() - 0.5) * 10 : -15; // 照片模式从中间发射
    const launchZ = isPhotoMode ? 45 + Math.random() * 15 : 40 + Math.random() * 20;

    // 爆炸高度
    const explosionHeight = isPhotoMode ? launchY + 3 + Math.random() * 8 : 15 + Math.random() * 15;
    const explosionPos = new Float32Array([launchX, explosionHeight, launchZ]);

    // 发射速度
    const launchSpeed = isPhotoMode ? 15 + Math.random() * 10 : 20 + Math.random() * 15;
    const timeToExplode = Math.abs(explosionHeight - launchY) / launchSpeed;

    const velocities = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const explosionTime = new Float32Array(count);

    // 统一使用优雅的金色暖调主题，保持视觉一致性
    const baseColors: Array<[number, number, number]> = [
      [1.0, 0.84, 0.0], // 金色
      [1.0, 0.95, 0.5], // 暖白
      [1.0, 0.6, 0.2],  // 琥珀色
      [1.0, 1.0, 0.8]   // 白金
    ];

    for (let i = 0; i < count; i++) {
      // 爆炸后的速度方向（球形散开）
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const explosionSpeed = isPhotoMode ? (12 + Math.random() * 20) : (8 + Math.random() * 15);

      velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * explosionSpeed;
      velocities[i * 3 + 1] = Math.cos(phi) * explosionSpeed * (isPhotoMode ? 0.4 : 0.3); // 照片模式更多向上
      velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * explosionSpeed;

      // 随机选择颜色，照片模式有更高的亮度
      const colorIndex = Math.floor(Math.random() * baseColors.length);
      const [r, g, b] = baseColors[colorIndex];
      const brightness = isPhotoMode ? 1.0 : 0.9; // 照片模式更亮
      colors[i * 3] = r * brightness;
      colors[i * 3 + 1] = g * brightness;
      colors[i * 3 + 2] = b * brightness;

      explosionTime[i] = timeToExplode + Math.random() * 0.15;
    }

    return {
      launchPos: new Float32Array([launchX, launchY, launchZ]),
      explosionPos,
      velocities,
      colors,
      explosionTime,
      lifetime: timeToExplode + (isPhotoMode ? 2.5 : 3.0), // 照片模式稍短生命周期
      startTime: Date.now(),
      isFirework: true
    };
  }, []);

  // 树形成时触发单次烟花
  useEffect(() => {
    if (triggerTreeForm && !isPhotoOpen) {
      setIsActive(true);
      startTime.current = Date.now();
      particleBatchesRef.current = [createFirework(false)];
      setTimeout(() => setIsActive(false), 2000);
    }
  }, [triggerTreeForm, isPhotoOpen, createFirework]);

  // 照片打开时持续发射烟花
  useEffect(() => {
    if (isPhotoOpen) {
      setIsActive(true);
      startTime.current = Date.now();
      nextSpawnTime.current = Date.now();
      particleBatchesRef.current = [createFirework(true)];
    } else if (!triggerTreeForm) {
      setIsActive(false);
      particleBatchesRef.current = [];
    }
  }, [isPhotoOpen, triggerTreeForm, createFirework]);

  useFrame((_state, delta) => {
    if (!particlesRef.current || !isActive) return;

    const now = Date.now();

    // 照片打开时每隔0.3秒发射新烟花，最多8个同时存在（更密集的效果）
    if (isPhotoOpen && now >= nextSpawnTime.current && particleBatchesRef.current.length < 8) {
      particleBatchesRef.current.push(createFirework(true));
      nextSpawnTime.current = now + 300;
    }

    // 移除超过生命周期的旧烟花
    particleBatchesRef.current = particleBatchesRef.current.filter(
      batch => (now - batch.startTime) / 1000 < batch.lifetime
    );

    // 计算所有粒子的位置
    const allPositions: number[] = [];
    const allColors: number[] = [];

    particleBatchesRef.current.forEach(batch => {
      const elapsed = (now - batch.startTime) / 1000;
      const launchX = batch.launchPos[0];
      const launchY = batch.launchPos[1];
      const launchZ = batch.launchPos[2];
      const explodeX = batch.explosionPos[0];
      const explodeY = batch.explosionPos[1];
      const explodeZ = batch.explosionPos[2];

      const particleCount = batch.velocities.length / 3;
      for (let i = 0; i < particleCount; i++) {
        const tExplode = batch.explosionTime[i];

        let x, y, z;
        if (elapsed < tExplode) {
          // 第一阶段：向上发射
          const launchSpeed = (explodeY - launchY) / tExplode;
          x = launchX;
          y = launchY + launchSpeed * elapsed;
          z = launchZ;
        } else {
          // 第二阶段：爆炸散开
          const t = elapsed - tExplode;
          if (t < 3.0) {
            x = explodeX + batch.velocities[i * 3] * t;
            y = explodeY + batch.velocities[i * 3 + 1] * t + 0.5 * (-12) * t * t;
            z = explodeZ + batch.velocities[i * 3 + 2] * t;
          } else {
            continue;
          }
        }

        allPositions.push(x, y, z);
        allColors.push(batch.colors[i * 3], batch.colors[i * 3 + 1], batch.colors[i * 3 + 2]);
      }
    });

    if (allPositions.length > 0) {
      const geometry = particlesRef.current.geometry;
      const posArray = new Float32Array(allPositions);
      const colorArray = new Float32Array(allColors);
      geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    }

    if (materialRef.current) {
      // 平滑过渡透明度
      materialRef.current.opacity = MathUtils.damp(materialRef.current.opacity, opacity, 5, delta);
    }
  });

  if (!isActive) return null;

  return (
    <points ref={particlesRef}>
      <bufferGeometry />
      <pointsMaterial ref={materialRef} size={isPhotoOpen ? 0.4 : 1.5} vertexColors transparent opacity={1.0} blending={THREE.AdditiveBlending} />
    </points>
  );
};


// --- Component: Top Star (No Photo, Pure Gold 3D Star) ---
const TopStar = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const groupRef = useRef<THREE.Group>(null);

  const starShape = useMemo(() => {
    const shape = new THREE.Shape();
    const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath();
    return shape;
  }, []);

  const starGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, // 增加一点厚度
      bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3,
    });
  }, [starShape]);

  // 纯金材质
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: CONFIG.colors.gold,
    emissive: CONFIG.colors.gold,
    emissiveIntensity: 1.5, // 适中亮度，既发光又有质感
    roughness: 0.1,
    metalness: 1.0,
  }), []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });

  return (
    <group ref={groupRef} position={[0, CONFIG.tree.height / 2 + 1.8, 0]}>
      <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}>
        <mesh geometry={starGeometry} material={goldMaterial} />
      </Float>
    </group>
  );
};



// --- Main Scene Experience ---
const Experience = ({ sceneState, rotationSpeed, handPosition, onLightboxStateChange, lightboxOpacity, setLightboxOpacity }: { sceneState: 'CHAOS' | 'FORMED', rotationSpeed: number, handPosition: any, onLightboxStateChange: (isOpen: boolean, photoIndex: number | null) => void, lightboxOpacity: number, setLightboxOpacity: (opacity: number) => void }) => {
  const controlsRef = useRef<any>(null);
  const photoGroupRef = useRef<THREE.Group>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [, setLightboxPhotoIndex] = useState<number | null>(null);
  const hasPinchedRef = useRef(false);
  const [fireworkTrigger, setFireworkTrigger] = useState(false);
  const prevSceneState = useRef(sceneState);
  const fadeOutTimerRef = useRef<number | null>(null);
  const recentlyViewedPhotos = useRef<number[]>([]); // 记录最近查看过的照片索引
  const MAX_RECENT_HISTORY = 10; // 最多记录10张最近查看的照片

  useEffect(() => {
    // 当从CHAOS变为FORMED时触发烟花
    if (prevSceneState.current === 'CHAOS' && sceneState === 'FORMED') {
      setFireworkTrigger(true);
      setTimeout(() => setFireworkTrigger(false), 100);
    }
    prevSceneState.current = sceneState;
  }, [sceneState]);

  useFrame(({ camera }) => {
    // 旋转控制 - 查看大图时停止旋转
    const effectiveRotationSpeed = isLightboxOpen ? 0 : rotationSpeed;
    if (controlsRef.current) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + effectiveRotationSpeed);
      controlsRef.current.update();
    }

    // 捏合打开照片 - 智能随机选择逻辑
    if (handPosition && handPosition.isPinching === true && !isLightboxOpen && !hasPinchedRef.current) {
      if (photoGroupRef.current) {
        // 第一步：找出距离最近的前5张照片
        const photoDistances: Array<{ index: number; distance: number; textureIndex: number }> = [];

        photoGroupRef.current.children.forEach((group, i) => {
          const distance = camera.position.distanceTo(group.position);
          const textureIndex = i % CONFIG.photos.body.length;
          photoDistances.push({ index: i, distance, textureIndex });
        });

        // 按距离排序，取最近的5张
        photoDistances.sort((a, b) => a.distance - b.distance);
        const nearestPhotos = photoDistances.slice(0, Math.min(5, photoDistances.length));

        // 第二步：从最近的5张中过滤掉最近查看过的
        let candidatePhotos = nearestPhotos.filter(
          photo => !recentlyViewedPhotos.current.includes(photo.textureIndex)
        );

        // 如果所有最近的照片都查看过了，就使用所有最近的照片（允许重复）
        if (candidatePhotos.length === 0) {
          candidatePhotos = nearestPhotos;
        }

        // 第三步：从候选照片中随机选择一张（带权重，越近权重越高）
        const totalWeight = candidatePhotos.reduce((sum, _, i) => {
          const weight = candidatePhotos.length - i; // 越近权重越高
          return sum + weight;
        }, 0);

        let randomValue = Math.random() * totalWeight;
        let selectedPhoto = candidatePhotos[0];

        for (let i = 0; i < candidatePhotos.length; i++) {
          const weight = candidatePhotos.length - i;
          randomValue -= weight;
          if (randomValue <= 0) {
            selectedPhoto = candidatePhotos[i];
            break;
          }
        }

        const textureIndex = selectedPhoto.textureIndex;

        // 第四步：更新最近查看历史
        recentlyViewedPhotos.current.push(textureIndex);
        if (recentlyViewedPhotos.current.length > MAX_RECENT_HISTORY) {
          recentlyViewedPhotos.current.shift(); // 移除最旧的记录
        }

        setIsLightboxOpen(true);
        setLightboxPhotoIndex(textureIndex);
        setLightboxOpacity(0); // 从0开始淡入
        onLightboxStateChange(true, textureIndex);
        hasPinchedRef.current = true;

        // 清除任何待处理的淡出计时器
        if (fadeOutTimerRef.current) {
          clearTimeout(fadeOutTimerRef.current);
          fadeOutTimerRef.current = null;
        }

        // 淡入动画
        setTimeout(() => {
          setLightboxOpacity(1);
        }, 10);
      }
    }

    // 松开手指关闭 Lightbox (带淡出效果) - 需要明确检查isPinching不为true
    if (!handPosition || handPosition.isPinching !== true) {
      if (isLightboxOpen && !fadeOutTimerRef.current) {
        // 开始淡出动画
        setLightboxOpacity(0);

        // 400ms后真正关闭lightbox
        fadeOutTimerRef.current = window.setTimeout(() => {
          setIsLightboxOpen(false);
          setLightboxPhotoIndex(null);
          onLightboxStateChange(false, null);
          fadeOutTimerRef.current = null;
        }, 400);
      }
      hasPinchedRef.current = false;
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 8, 60]} fov={45} />
      <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={rotationSpeed === 0 && sceneState === 'FORMED'} autoRotateSpeed={0.3} maxPolarAngle={Math.PI / 1.7} />

      <color attach="background" args={['#000300']} />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      <Environment preset="night" background={false} />

      <ambientLight intensity={0.4} color="#003311" />
      <pointLight position={[30, 30, 30]} intensity={150} color={CONFIG.colors.warmLight} />
      <pointLight position={[-30, 10, -30]} intensity={80} color={CONFIG.colors.gold} />
      <pointLight position={[0, -20, 10]} intensity={50} color="#ffffff" />
      {/* 聚合时额外的聚光灯效果 */}
      {sceneState === 'FORMED' && (
        <>
          <spotLight position={[0, 40, 0]} angle={0.5} penumbra={0.5} intensity={200} color={CONFIG.colors.gold} target-position={[0, 0, 0]} castShadow />
          <pointLight position={[15, 20, 15]} intensity={100} color="#FFD700" />
          <pointLight position={[-15, 20, -15]} intensity={100} color="#FFD700" />
        </>
      )}

      <group position={[0, 0, 0]}>
        <Foliage state={sceneState} />
        <Suspense fallback={null}>
           <PhotoOrnaments state={sceneState} onPhotoClick={() => {}} groupRef={photoGroupRef} hoveredIndex={null} />
           <ChristmasElements state={sceneState} />
           <FairyLights state={sceneState} />
           <TopStar state={sceneState} />
        </Suspense>
        <Sparkles count={1000} scale={60} size={10} speed={0.4} opacity={0.6} color={CONFIG.colors.silver} />
        <ParticleEffect triggerTreeForm={fireworkTrigger} isPhotoOpen={isLightboxOpen} opacity={isLightboxOpen ? lightboxOpacity : 1.0} />
      </group>

      <EffectComposer>
        <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={1.5} radius={0.5} mipmapBlur />
        <Vignette eskil={false} offset={0.1} darkness={1.2} />
      </EffectComposer>
    </>
  );
};

// --- Gesture Controller ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GestureController = ({ onGesture, onMove, onStatus, debugMode, onHandPosition }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastGestureRef = useRef<string>('');
  const gestureStableCountRef = useRef<number>(0);

  useEffect(() => {
    let gestureRecognizer: GestureRecognizer;
    let requestRef: number;

    const setup = async () => {
      onStatus("DOWNLOADING AI...");
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });
        onStatus("REQUESTING CAMERA...");
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
            onStatus("AI READY: SHOW HAND");
            predictWebcam();
          }
        } else {
            onStatus("ERROR: CAMERA PERMISSION DENIED");
        }
      } catch (err: any) {
        onStatus(`ERROR: ${err.message || 'MODEL FAILED'}`);
      }
    };

    const predictWebcam = () => {
      if (gestureRecognizer && videoRef.current && canvasRef.current) {
        if (videoRef.current.videoWidth > 0) {
            const results = gestureRecognizer.recognizeForVideo(videoRef.current, Date.now());
            const ctx = canvasRef.current.getContext("2d");
            if (ctx && debugMode) {
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                canvasRef.current.width = videoRef.current.videoWidth; canvasRef.current.height = videoRef.current.videoHeight;
                if (results.landmarks) for (const landmarks of results.landmarks) {
                        const drawingUtils = new DrawingUtils(ctx);
                        drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#FFD700", lineWidth: 2 });
                        drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 1 });
                }
            } else if (ctx && !debugMode) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

            if (results.gestures.length > 0) {
              const name = results.gestures[0][0].categoryName; const score = results.gestures[0][0].score;

              // 跟踪手势稳定性 - 只有当手势稳定时才触发状态改变
              if (name === lastGestureRef.current) {
                gestureStableCountRef.current++;
              } else {
                lastGestureRef.current = name;
                gestureStableCountRef.current = 0;
              }

              if (score > 0.4 && gestureStableCountRef.current >= 3) {
                 if (name === "Open_Palm") onGesture("CHAOS");
                 if (name === "Closed_Fist") onGesture("FORMED");
                 if (debugMode) onStatus(`DETECTED: ${name}`);
              }
              if (results.landmarks.length > 0) {
                const speed = (0.5 - results.landmarks[0][0].x) * 0.15;
                onMove(Math.abs(speed) > 0.01 ? speed : 0);

                // 传递食指尖端位置用于指针控制
                const indexFingerTip = results.landmarks[0][8]; // MediaPipe index finger tip
                const thumbTip = results.landmarks[0][4]; // MediaPipe thumb tip

                // 计算捏合手势（食指和拇指的3D距离）
                const dx = indexFingerTip.x - thumbTip.x;
                const dy = indexFingerTip.y - thumbTip.y;
                const dz = (indexFingerTip.z || 0) - (thumbTip.z || 0);
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                // 优化的捏合检测逻辑：
                // 1. 距离必须<0.08（手指接近，阈值放宽）
                // 2. 不能是Closed_Fist或Open_Palm（避免过渡期误触）
                // 3. 识别分数>0.5（适中置信度）
                // 4. 手势状态检查：只在非握拳/非张开状态时允许捏合
                const isNotFistOrPalm = name !== "Closed_Fist" && name !== "Open_Palm";
                const isPinching = distance < 0.08 &&
                                   isNotFistOrPalm &&
                                   score > 0.5;

                onHandPosition({
                  x: indexFingerTip.x,
                  y: indexFingerTip.y,
                  z: indexFingerTip.z || 0,
                  visible: true,
                  gesture: name,
                  isPinching: isPinching === true ? true : false // 严格boolean值
                });
              }
            } else {
              onMove(0);
              lastGestureRef.current = '';
              gestureStableCountRef.current = 0;
              onHandPosition({ visible: false, isPinching: false, x: 0, y: 0, z: 0, gesture: '' });
              if (debugMode) onStatus("AI READY: NO HAND");
            }
        }
        requestRef = requestAnimationFrame(predictWebcam);
      }
    };
    setup();
    return () => cancelAnimationFrame(requestRef);
  }, [onGesture, onMove, onStatus, debugMode, onHandPosition]);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', bottom: 0, right: 0, width: debugMode ? '200px' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', bottom: 0, right: 0, width: debugMode ? '200px' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

// --- App Entry ---
export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<'CHAOS' | 'FORMED'>('CHAOS');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [, setAiStatus] = useState("INITIALIZING...");
  const [debugMode, setDebugMode] = useState(false);
  const [handPosition, setHandPosition] = useState({ visible: false, x: 0, y: 0, z: 0, gesture: '', isPinching: false });
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxPhotoIndex, setLightboxPhotoIndex] = useState<number | null>(null);
  const [lightboxOpacity, setLightboxOpacity] = useState(1);
  const [isMusicPlaying, setIsMusicPlaying] = useState(true); // 默认状态为播放
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 页面加载时自动播放音乐
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = 0.7; // 设置音量
      const playPromise = audioRef.current.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setIsMusicPlaying(true);
          })
          .catch(() => {
            // 如果自动播放失败（浏览器限制），等待用户交互
            setIsMusicPlaying(false);
          });
      }
    }
  }, []);

  const handleLightboxStateChange = (isOpen: boolean, photoIndex: number | null) => {
    setIsLightboxOpen(isOpen);
    setLightboxPhotoIndex(photoIndex);
  };

  const toggleMusic = () => {
    if (audioRef.current) {
      if (isMusicPlaying) {
        audioRef.current.pause();
        setIsMusicPlaying(false);
      } else {
        // 播放音乐并捕获 Promise
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              setIsMusicPlaying(true);
            })
            .catch((error) => {
              console.error('Audio playback failed:', error);
              // 浏览器可能阻止了自动播放
              setIsMusicPlaying(false);
            });
        }
      }
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas dpr={[1, 2]} gl={{ toneMapping: THREE.ReinhardToneMapping }} shadows>
            <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} handPosition={handPosition} onLightboxStateChange={handleLightboxStateChange} lightboxOpacity={lightboxOpacity} setLightboxOpacity={setLightboxOpacity} />
        </Canvas>
      </div>
      <GestureController onGesture={setSceneState} onMove={setRotationSpeed} onStatus={setAiStatus} debugMode={debugMode} onHandPosition={setHandPosition} />

      {/* Lightbox Modal - 仅通过松开手指关闭 */}
      {isLightboxOpen && lightboxPhotoIndex !== null && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000,
            pointerEvents: 'none',
            opacity: lightboxOpacity,
            transition: 'opacity 0.4s ease-in-out'
          }}
        >
          <div
            style={{
              position: 'relative',
              animation: 'fadeIn 0.3s ease-in-out'
            }}
          >
            <img
              src={CONFIG.photos.body[lightboxPhotoIndex]}
              alt={`Photo ${lightboxPhotoIndex + 1}`}
              style={{
                height: '75vh',
                width: 'auto',
                maxWidth: '90vw',
                objectFit: 'contain',
                borderRadius: '8px',
                boxShadow: '0 0 80px rgba(255, 215, 0, 0.8)'
              }}
            />
            {/* 提示文字 */}
            <div style={{
              position: 'absolute',
              bottom: '-40px',
              left: '50%',
              transform: 'translateX(-50%)',
              color: CONFIG.colors.gold,
              fontSize: '14px',
              letterSpacing: '2px',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              textShadow: '0 0 10px rgba(255, 215, 0, 0.5)'
            }}>
              松开手指关闭 / Release to close
            </div>
          </div>
        </div>
      )}

      {/* UI - Top Greeting */}
      <div style={{ position: 'absolute', top: '30px', left: '50%', transform: 'translateX(-50%)', color: CONFIG.colors.gold, fontSize: '28px', letterSpacing: '3px', zIndex: 10, fontFamily: 'serif', fontWeight: 'bold', textShadow: '0 0 20px rgba(255, 215, 0, 0.8)' }}>
        Merry Christmas~
      </div>

      {/* UI - Music and Debug Buttons (Top Right) */}
      <div style={{ position: 'absolute', top: '30px', right: '40px', zIndex: 10, display: 'flex', gap: '12px' }}>
        <button onClick={toggleMusic} style={{ padding: '12px 20px', backgroundColor: isMusicPlaying ? '#FFD700' : 'rgba(0,0,0,0.5)', border: '1px solid #FFD700', color: isMusicPlaying ? '#000' : '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)', letterSpacing: '1px' }}>
          {isMusicPlaying ? '🎵 PAUSE' : '🎵 PLAY'}
        </button>
        <button onClick={() => setDebugMode(!debugMode)} style={{ padding: '12px 20px', backgroundColor: debugMode ? '#FFD700' : 'rgba(0,0,0,0.5)', border: '1px solid #FFD700', color: debugMode ? '#000' : '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)', letterSpacing: '1px' }}>
           {debugMode ? 'HIDE' : 'SHOW'}
        </button>
      </div>

      {/* Background Music */}
      <audio
        ref={audioRef}
        src="/BGM.mp3"
        loop
        preload="auto"
      />
    </div>
  );
}
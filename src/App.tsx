import { useState, useMemo, useRef, useEffect, Suspense, useCallback } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import {
  OrbitControls,
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

// --- 动态生成照片列表 (top.jpg + 1.jpg 到 N.jpg) ---
const TOTAL_NUMBERED_PHOTOS = 34;
// 修改：将 top.jpg 加入到数组开头
const asset = (p: string) => `${import.meta.env.BASE_URL}${p}`;
const bodyPhotoPaths = [
  asset('backup_photos/top.jpg'),
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => asset(`backup_photos/${i + 1}.jpg`))
];

const LOCAL_PHOTOS_DB = 'christmas-tree'
const LOCAL_PHOTOS_STORE = 'kv'
const LOCAL_PHOTOS_KEY = 'localPhotosV1'

const openLocalPhotosDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_PHOTOS_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(LOCAL_PHOTOS_STORE)) {
        db.createObjectStore(LOCAL_PHOTOS_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const localKvGet = async <T,>(key: string): Promise<T | null> => {
  const db = await openLocalPhotosDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_PHOTOS_STORE, 'readonly')
    const store = tx.objectStore(LOCAL_PHOTOS_STORE)
    const req = store.get(key)
    req.onsuccess = () => {
      const result = req.result as { key: string; value: T } | undefined
      resolve(result ? result.value : null)
    }
    req.onerror = () => reject(req.error)
  })
}

const localKvSet = async <T,>(key: string, value: T): Promise<void> => {
  const db = await openLocalPhotosDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_PHOTOS_STORE, 'readwrite')
    const store = tx.objectStore(LOCAL_PHOTOS_STORE)
    const req = store.put({ key, value })
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

const localKvDelete = async (key: string): Promise<void> => {
  const db = await openLocalPhotosDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_PHOTOS_STORE, 'readwrite')
    const store = tx.objectStore(LOCAL_PHOTOS_STORE)
    const req = store.delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

const readFileAsDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const getLocalPhotos = async (): Promise<string[]> => {
  try {
    const value = await localKvGet<string[]>(LOCAL_PHOTOS_KEY)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const addLocalPhotos = async (files: File[]): Promise<string[]> => {
  const existing = await getLocalPhotos()
  const dataUrls = (await Promise.all(files.map(readFileAsDataUrl))).filter(Boolean)
  const next = [...dataUrls, ...existing]
  await localKvSet(LOCAL_PHOTOS_KEY, next)
  return next
}

const deleteLocalPhoto = async (photoUrl: string): Promise<string[]> => {
  const existing = await getLocalPhotos()
  const next = existing.filter(u => u !== photoUrl)
  await localKvSet(LOCAL_PHOTOS_KEY, next)
  return next
}

const resetLocalPhotos = async (): Promise<void> => {
  await localKvDelete(LOCAL_PHOTOS_KEY)
}

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
const PhotoOrnaments = ({ state, onPhotoClick, groupRef, hoveredIndex, photos }: { state: 'CHAOS' | 'FORMED', onPhotoClick: (index: number) => void, groupRef: React.RefObject<THREE.Group>, hoveredIndex: number | null, photos: string[] }) => {
  // 安全检查：如果 photos 为空或未定义，则不加载纹理，避免崩溃
  if (!photos || photos.length === 0) return null;
  const textures = useTexture(photos);
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
  }, [count]);

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
  }, [count]);

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
const Experience = ({ sceneState, rotationSpeed, handPosition, onLightboxStateChange, lightboxOpacity, setLightboxOpacity, photos }: { sceneState: 'CHAOS' | 'FORMED', rotationSpeed: number, handPosition: any, onLightboxStateChange: (isOpen: boolean, photoIndex: number | null) => void, lightboxOpacity: number, setLightboxOpacity: (opacity: number) => void, photos: string[] }) => {
  const controlsRef = useRef<any>(null);
  const photoGroupRef = useRef<THREE.Group>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [, setLightboxPhotoIndex] = useState<number | null>(null);
  const hasPinchedRef = useRef(false);
  const pinchCooldownUntilRef = useRef(0);
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
    pinchCooldownUntilRef.current = Date.now() + 650;
  }, [sceneState]);

  useFrame(({ camera }) => {
    // 旋转控制 - 查看大图时停止旋转
    const effectiveRotationSpeed = isLightboxOpen ? 0 : rotationSpeed;
    if (controlsRef.current) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + effectiveRotationSpeed);
      controlsRef.current.update();
    }

    // 捏合打开照片 - 智能随机选择逻辑
    if (Date.now() >= pinchCooldownUntilRef.current && handPosition && handPosition.isPinching === true && !isLightboxOpen && !hasPinchedRef.current) {
      if (photoGroupRef.current) {
        // 第一步：找出距离最近的前5张照片
        const photoDistances: Array<{ index: number; distance: number; textureIndex: number }> = [];

        photoGroupRef.current.children.forEach((group, i) => {
          const distance = camera.position.distanceTo(group.position);
          const textureIndex = i % photos.length;
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
      {/* <Environment preset="night" background={false} /> */}
      
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
           <PhotoOrnaments state={sceneState} onPhotoClick={() => {}} groupRef={photoGroupRef} hoveredIndex={null} photos={photos} />
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
const GestureController = ({ onGesture, onMove, onStatus, debugMode, onHandPosition, isLightboxOpen }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastGestureRef = useRef<string>('');
  const gestureStableCountRef = useRef<number>(0);
  const pinchStateRef = useRef(false);
  const pinchChangeStableCountRef = useRef(0);
  const lastRuntimeErrorRef = useRef<string>('');

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
            const el = videoRef.current;
            const safePlay = () => {
              const p = el.play();
              if (p && typeof p.then === 'function') p.catch(() => {});
            };
            if (el.readyState >= 2) {
              safePlay();
            } else {
              el.onloadedmetadata = () => safePlay();
            }
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
        try {
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

            let name = '';
            let score = 0;
            if (results.gestures.length > 0) {
              name = results.gestures[0][0].categoryName;
              score = results.gestures[0][0].score;

              if (name === lastGestureRef.current) {
                gestureStableCountRef.current++;
              } else {
                lastGestureRef.current = name;
                gestureStableCountRef.current = 0;
              }

              if (score > 0.35 && gestureStableCountRef.current >= 2) {
                if (name === "Open_Palm") onGesture("CHAOS");
                if (name === "Closed_Fist") onGesture("FORMED");
                if (debugMode) onStatus(`DETECTED: ${name}`);
              }
            }

            const l = results.landmarks?.[0];
            if (l && l.length > 0) {
              const speed = (0.5 - l[0].x) * 0.15;
              onMove(Math.abs(speed) > 0.01 ? speed : 0);

              const indexFingerTip = l[8];
              const thumbTip = l[4];

              const dx = indexFingerTip.x - thumbTip.x;
              const dy = indexFingerTip.y - thumbTip.y;
              const dz = (indexFingerTip.z || 0) - (thumbTip.z || 0);
              const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

              const wrist = l[0];
              const palmBase = l[9] || l[5] || l[0];
              const palmSize = Math.hypot(
                wrist.x - palmBase.x,
                wrist.y - palmBase.y,
                (wrist.z || 0) - (palmBase.z || 0)
              ) || 1e-6;
              const opennessTipIds = [8, 12, 16, 20];
              let tipSum = 0;
              for (const id of opennessTipIds) {
                const tip = l[id];
                tipSum += Math.hypot(
                  wrist.x - tip.x,
                  wrist.y - tip.y,
                  (wrist.z || 0) - (tip.z || 0)
                );
              }
              const openness = (tipSum / opennessTipIds.length) / palmSize;
              const opennessOk = openness > 1.35 && openness < 2.25;

              const gestureBlocksPinch = name === "Closed_Fist" || name === "Open_Palm";
              const pinchDownThreshold = 0.072;
              const pinchUpThreshold = 0.098;
              const pinchingByDistance = pinchStateRef.current ? distance < pinchUpThreshold : distance < pinchDownThreshold;
              const scoreOk = name ? score > 0.5 : true;
              const rawPinch = !gestureBlocksPinch && scoreOk && opennessOk && pinchingByDistance;

              if (gestureBlocksPinch) {
                pinchStateRef.current = false;
                pinchChangeStableCountRef.current = 0;
              } else if (rawPinch === pinchStateRef.current) {
                pinchChangeStableCountRef.current = 0;
              } else {
                pinchChangeStableCountRef.current++;
                if (pinchChangeStableCountRef.current >= 2) {
                  pinchStateRef.current = rawPinch;
                  pinchChangeStableCountRef.current = 0;
                }
              }

              onHandPosition({
                x: indexFingerTip.x,
                y: indexFingerTip.y,
                z: indexFingerTip.z || 0,
                visible: true,
                gesture: name,
                isPinching: pinchStateRef.current === true ? true : false
              });
            } else {
              onMove(0);
              pinchStateRef.current = false;
              pinchChangeStableCountRef.current = 0;
              onHandPosition({ visible: false, isPinching: false, x: 0, y: 0, z: 0, gesture: name });
              if (results.gestures.length === 0) {
                lastGestureRef.current = '';
                gestureStableCountRef.current = 0;
                if (debugMode) onStatus("AI READY: NO HAND");
              }
            }
          }
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (lastRuntimeErrorRef.current !== msg) {
            lastRuntimeErrorRef.current = msg;
            onStatus(`ERROR: ${msg}`);
          }
          onMove(0);
          lastGestureRef.current = '';
          gestureStableCountRef.current = 0;
          pinchStateRef.current = false;
          pinchChangeStableCountRef.current = 0;
          onHandPosition({ visible: false, isPinching: false, x: 0, y: 0, z: 0, gesture: '' });
        }

        requestRef = requestAnimationFrame(predictWebcam);
      }
    };
    setup();
    return () => cancelAnimationFrame(requestRef);
  }, [onGesture, onMove, onStatus, debugMode, onHandPosition]);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', bottom: 0, right: 0, width: debugMode ? 'min(30vw, 40vh)' : '1px', zIndex: debugMode ? (isLightboxOpen ? 1600 : 100) : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', bottom: 0, right: 0, width: debugMode ? 'min(30vw, 40vh)' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? (isLightboxOpen ? 1601 : 101) : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

const ClassicFireworksBackdrop = ({ active, opacity }: { active: boolean; opacity: number }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const fireworksRef = useRef<any[]>([]);
  const opacityRef = useRef(1);

  useEffect(() => {
    opacityRef.current = opacity;
  }, [opacity]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const context = ctx;

    const config = {
      density: 160,
      speed: 10,
      gravity: 0.12,
      particleSize: 1.6,
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    class Particle {
      x: number;
      y: number;
      color: string;
      velocity: { x: number; y: number };
      gravity: number;
      alpha: number;
      decay: number;
      size: number;
      trail: Array<{ x: number; y: number; alpha: number }>;

      constructor(x: number, y: number, color: string, velocity: { x: number; y: number }, gravity = config.gravity) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.velocity = velocity;
        this.gravity = gravity;
        this.alpha = 1;
        this.decay = Math.random() * 0.02 + 0.01;
        this.size = Math.random() * config.particleSize + config.particleSize * 0.5;
        this.trail = [];
      }

      update() {
        this.velocity.y += this.gravity;
        this.x += this.velocity.x;
        this.y += this.velocity.y;
        this.alpha -= this.decay;
        this.trail.push({ x: this.x, y: this.y, alpha: this.alpha });
        if (this.trail.length > 10) this.trail.shift();
      }

      draw() {
        context.save();
        this.trail.forEach((point, index) => {
          context.globalAlpha = point.alpha * (index / this.trail.length) * 0.5;
          context.fillStyle = this.color;
          context.fillRect(point.x, point.y, this.size * 0.5, this.size * 0.5);
        });
        context.restore();

        context.save();
        context.globalAlpha = this.alpha;
        const gradient = context.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.size * 2);
        gradient.addColorStop(0, this.color);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.fillStyle = gradient;
        context.fillRect(this.x - this.size * 2, this.y - this.size * 2, this.size * 4, this.size * 4);
        context.fillStyle = this.color;
        context.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
        context.restore();
      }

      isDead() {
        return this.alpha <= 0;
      }
    }

    class Firework {
      x: number;
      y: number;
      targetY: number;
      velocity: { x: number; y: number };
      exploded: boolean;
      particles: Particle[];
      trail: Array<{ x: number; y: number }>;
      hue: number;
      color: string;

      constructor(x: number, y: number, instantExplode = false) {
        this.x = x;
        this.targetY = y;
        this.particles = [];
        this.trail = [];
        this.hue = Math.random() * 360;
        this.color = `hsl(${this.hue}, 100%, 60%)`;

        if (instantExplode) {
          this.y = y;
          this.velocity = { x: 0, y: 0 };
          this.exploded = true;
          this.explode();
        } else {
          this.y = window.innerHeight;
          this.velocity = { x: 0, y: -config.speed };
          this.exploded = false;
        }
      }

      update() {
        if (!this.exploded) {
          this.trail.push({ x: this.x, y: this.y });
          if (this.trail.length > 10) this.trail.shift();
          this.velocity.y += 0.05;
          this.y += this.velocity.y;
          if (this.y <= this.targetY) this.explode();
        } else {
          this.particles = this.particles.filter(p => {
            p.update();
            return !p.isDead();
          });
        }
      }

      explode() {
        this.exploded = true;
        const particleCount = config.density;
        for (let i = 0; i < particleCount; i++) {
          const angle = (Math.PI * 2 * i) / particleCount;
          const speed = Math.random() * 7 + 3;
          const velocity = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
          const hue = this.hue + Math.random() * 60 - 30;
          const color = `hsl(${hue}, 100%, ${Math.random() * 20 + 50}%)`;
          this.particles.push(new Particle(this.x, this.y, color, velocity));
        }
      }

      draw() {
        if (!this.exploded) {
          context.save();
          this.trail.forEach((point, index) => {
            context.globalAlpha = index / this.trail.length;
            context.fillStyle = this.color;
            context.fillRect(point.x - 2, point.y - 2, 4, 4);
          });
          context.globalAlpha = 1;
          const gradient = context.createRadialGradient(this.x, this.y, 0, this.x, this.y, 8);
          gradient.addColorStop(0, 'white');
          gradient.addColorStop(1, this.color);
          context.fillStyle = gradient;
          context.fillRect(this.x - 3, this.y - 3, 6, 6);
          context.restore();
        } else {
          this.particles.forEach(p => p.draw());
        }
      }

      isDead() {
        return this.exploded && this.particles.length === 0;
      }
    }

    let lastSpawnAt = 0;
    const spawn = () => {
      const x = Math.random() * window.innerWidth;
      const y = window.innerHeight * (0.15 + Math.random() * 0.6);
      fireworksRef.current.push(new Firework(x, y, true));
      if (fireworksRef.current.length > 14) fireworksRef.current.shift();
    };

    const animate = (t: number) => {
      const maskAlpha = 0.15 + 0.12 * (1 - Math.min(1, opacityRef.current));
      context.fillStyle = `rgba(5, 5, 16, ${maskAlpha})`;
      context.fillRect(0, 0, window.innerWidth, window.innerHeight);

      if (t - lastSpawnAt > 180) {
        lastSpawnAt = t;
        spawn();
      }

      fireworksRef.current = fireworksRef.current.filter(f => {
        f.update();
        f.draw();
        return !f.isDead();
      });

      rafRef.current = requestAnimationFrame(animate);
    };

    fireworksRef.current = [];
    spawn();
    spawn();
    spawn();
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      window.removeEventListener('resize', resize);
      fireworksRef.current = [];
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: Math.min(1, opacity),
      }}
    />
  );
};

// --- Linear Style System ---
const LINEAR_STYLE = {
  glassPanel: {
    background: 'rgba(20, 20, 20, 0.6)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
  },
  button: {
    background: 'transparent',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    color: 'rgba(255, 255, 255, 0.6)',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    outline: 'none',
    fontWeight: 400
  },
  buttonHover: {
    background: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    color: '#fff',
  },
  modalOverlay: {
    position: 'fixed' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0, 0, 0, 0.7)',
    backdropFilter: 'blur(5px)',
    zIndex: 2000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'fadeIn 0.2s ease-out'
  },
  modalContent: {
    background: '#161616',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '12px',
    padding: '24px',
    width: 'min(90vw, 600px)',
    maxHeight: '85vh',
    overflowY: 'auto' as const,
    boxShadow: '0 24px 48px rgba(0, 0, 0, 0.5)',
    color: '#fff',
    animation: 'scaleIn 0.2s ease-out'
  }
};

const LinearButton = ({ children, onClick, style, disabled, active }: any) => {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...LINEAR_STYLE.button,
        ...(hover && !disabled ? LINEAR_STYLE.buttonHover : {}),
        ...(active ? { background: 'rgba(255, 255, 255, 0.1)', borderColor: 'rgba(255, 255, 255, 0.3)', color: '#fff' } : {}),
        ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
        ...style
      }}
    >
      {children}
    </button>
  );
};

// --- Component: Editable Title ---
const EditableTitle = () => {
  const [title, setTitle] = useState(() => localStorage.getItem('tree_title') || 'Merry Christmas');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem('tree_title', title);
  }, [title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => setIsEditing(false)}
        onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
        style={{
          background: 'rgba(0,0,0,0.5)',
          border: 'none',
          borderBottom: '1px solid #FFD700',
          color: '#FFD700',
          fontSize: '28px',
          fontFamily: 'serif',
          fontWeight: 'bold',
          textAlign: 'center',
          outline: 'none',
          width: '300px',
          zIndex: 10
        }}
      />
    );
  }

  return (
    <div
      onClick={() => setIsEditing(true)}
      style={{
        cursor: 'pointer',
        color: CONFIG.colors.gold,
        fontSize: '28px',
        letterSpacing: '3px',
        fontFamily: 'serif',
        fontWeight: 'bold',
        textShadow: '0 0 20px rgba(255, 215, 0, 0.8)',
        zIndex: 10,
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}
      title="点击修改标题"
    >
      {title}
      <span style={{ fontSize: '12px', opacity: 0.3, fontWeight: 'normal' }}>✎</span>
    </div>
  );
};

// --- Component: Gesture Guide Modal ---
const GestureGuide = ({ onClose }: { onClose: () => void }) => {
  const gestures = [
    { icon: '🖐️', title: '五指张开', desc: 'Chaos Mode / 粒子散开' },
    { icon: '✊', title: '握拳', desc: 'Form Tree / 聚合成树' },
    { icon: '👌', title: '捏合 (食指+拇指)', desc: 'View Photo / 查看照片' },
    { icon: '👋', title: '手掌左右移动', desc: 'Rotate / 旋转视角' },
  ];

  return (
    <div style={LINEAR_STYLE.modalOverlay} onClick={onClose}>
      <div style={LINEAR_STYLE.modalContent} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>手势操作说明</h3>
          <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          {gestures.map((g, i) => (
            <div key={i} style={{ 
              background: 'rgba(255,255,255,0.03)', 
              borderRadius: '8px', 
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <div style={{ fontSize: '32px', marginBottom: '8px' }}>{g.icon}</div>
              <div style={{ fontWeight: 600, marginBottom: '4px', color: '#FFD700' }}>{g.title}</div>
              <div style={{ fontSize: '12px', opacity: 0.7 }}>{g.desc}</div>
            </div>
          ))}
        </div>

        <div style={{ 
          background: 'rgba(255, 215, 0, 0.05)', 
          border: '1px solid rgba(255, 215, 0, 0.1)', 
          borderRadius: '8px', 
          padding: '16px',
          fontSize: '13px',
          lineHeight: '1.6',
          color: 'rgba(255, 255, 255, 0.8)'
        }}>
          <div style={{ fontWeight: 600, color: '#FFD700', marginBottom: '8px' }}>💡 最佳体验贴士：</div>
          <ul style={{ margin: 0, paddingLeft: '20px' }}>
            <li>建议开启 <b>“显示调试”</b> 确认摄像头已正确识别手部骨骼</li>
            <li>手掌请 <b>正对摄像头</b>，保持在画面中央，识别更准确</li>
            <li>手势变换时请 <b>保持缓慢</b>，给 AI 一点反应时间</li>
            <li>环境光线充足时识别效果最佳</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

// --- Component: Photo Manager ---
const PhotoManager = ({ photos, onClose, onUpdate }: { photos: string[], onClose: () => void, onUpdate: () => void }) => {
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    setUploading(true);
    const files = Array.from(e.target.files);
    const formData = new FormData();
    files.forEach(file => formData.append('photos', file));

    try {
      let uploadedToServer = false;
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}api/upload`, { method: 'POST', body: formData });
        if (res.ok) {
          uploadedToServer = true;
          onUpdate();
        }
      } catch {
        uploadedToServer = false;
      }

      if (!uploadedToServer) {
        await addLocalPhotos(files);
        onUpdate();
        alert('已保存到本地：GitHub Pages 为静态网站，无法上传到服务器。');
      }
    } catch (err) {
      console.error(err);
      alert('上传出错');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDelete = async (photoUrl: string) => {
    // 检查是否为备份照片（不允许删除）
    if (photoUrl.includes('backup_photos') || photoUrl.includes('top.jpg')) {
      alert('系统默认照片不可删除');
      return;
    }

    if (!confirm('确定删除这张照片吗？')) return;

    setDeleting(photoUrl);
    try {
      if (photoUrl.startsWith('data:')) {
        await deleteLocalPhoto(photoUrl);
        onUpdate();
        return;
      }

      const filename = photoUrl.split('?')[0].split('/').pop();
      if (!filename) {
        alert('删除失败');
        return;
      }

      const res = await fetch(`${import.meta.env.BASE_URL}api/photos?filename=${filename}`, { method: 'DELETE' });
      if (res.ok) {
        onUpdate();
        return;
      }
      const data = await res.json();
      alert(data.error || '删除失败');
    } catch (err) {
      console.error(err);
      alert('删除出错');
    } finally {
      setDeleting(null);
    }
  };

  const handleReset = async () => {
    if (!confirm('确定要重置所有照片吗？这将删除所有上传的照片并恢复默认图片。')) return;
    try {
      await fetch(`${import.meta.env.BASE_URL}api/reset`, { method: 'POST' }).catch(() => null);
      await resetLocalPhotos();
      onUpdate();
      alert('重置成功');
    } catch (err) {
      console.error(err);
      alert('重置出错');
    }
  };

  return (
    <div style={LINEAR_STYLE.modalOverlay} onClick={onClose}>
      <div style={LINEAR_STYLE.modalContent} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>图片管理</h3>
          <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
        </div>
        
        <div style={{ marginBottom: '20px', display: 'flex', gap: '12px' }}>
           <label style={{ ...LINEAR_STYLE.button, flex: 1, justifyContent: 'center', padding: '12px', background: 'rgba(255, 215, 0, 0.1)', borderColor: 'rgba(255, 215, 0, 0.3)', color: '#FFD700' }}>
             {uploading ? '正在上传...' : '＋ 上传新照片'}
             <input type="file" multiple accept="image/*" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
           </label>
           <button 
             onClick={handleReset}
             style={{ ...LINEAR_STYLE.button, flex: 1, justifyContent: 'center', padding: '12px', borderColor: 'rgba(255, 255, 255, 0.2)' }}
           >
             ↻ 图片重置
           </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '12px', maxHeight: '50vh', overflowY: 'auto' }}>
          {photos.map((url, i) => {
             const isBackup = url.includes('backup_photos') || url.includes('top.jpg');
             return (
              <div key={i} style={{ position: 'relative', aspectRatio: '1', borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                <img src={url} alt="thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                {!isBackup && (
                  <button 
                    onClick={() => handleDelete(url)}
                    disabled={deleting !== null}
                    style={{
                      position: 'absolute', top: '4px', right: '4px',
                      background: 'rgba(0,0,0,0.6)', color: 'white',
                      border: 'none', borderRadius: '4px',
                      width: '24px', height: '24px',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '14px'
                    }}
                    title="删除"
                  >
                    ✕
                  </button>
                )}
                {isBackup && (
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.5)', fontSize: '10px', textAlign: 'center', padding: '2px' }}>默认</div>
                )}
              </div>
             );
          })}
        </div>
        
        <div style={{ marginTop: '20px', fontSize: '12px', color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
          共 {photos.length} 张照片
        </div>
      </div>
    </div>
  );
};

// --- Component: Upload UI (Old - Deprecated, kept for reference but not used) ---
// We will replace its usage directly in App


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
  const [photos, setPhotos] = useState<string[]>([]);
  const [showPhotoManager, setShowPhotoManager] = useState(false);
  const [showGestureGuide, setShowGestureGuide] = useState(false);

  const fetchPhotos = useCallback(() => {
    fetch(`${import.meta.env.BASE_URL}api/photos`)
      .then(res => res.json())
      .then(files => {
        const timestamp = Date.now();
        const serverPaths = Array.isArray(files) ? files.map(f => `${import.meta.env.BASE_URL}${f}?t=${timestamp}`) : [];
        getLocalPhotos()
          .then(local => {
            const merged = [...local, ...(serverPaths.length > 0 ? serverPaths : []), ...bodyPhotoPaths]
            const deduped = Array.from(new Set(merged)).filter(Boolean)
            setPhotos(deduped)
          })
          .catch(() => {
            const merged = [...serverPaths, ...bodyPhotoPaths]
            setPhotos(Array.from(new Set(merged)).filter(Boolean))
          })
      })
      .catch(() => {
        getLocalPhotos()
          .then(local => {
            const merged = [...local, ...bodyPhotoPaths]
            setPhotos(Array.from(new Set(merged)).filter(Boolean))
          })
          .catch(() => setPhotos(bodyPhotoPaths));
      });
  }, []);

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

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
      {/* 3D Scene */}
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas dpr={[1, 2]} gl={{ toneMapping: THREE.ReinhardToneMapping }} shadows>
            <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} handPosition={handPosition} onLightboxStateChange={handleLightboxStateChange} lightboxOpacity={lightboxOpacity} setLightboxOpacity={setLightboxOpacity} photos={photos} />
        </Canvas>
      </div>
      
      {/* Gesture Controller (Invisible/Debug) */}
      <GestureController onGesture={setSceneState} onMove={setRotationSpeed} onStatus={setAiStatus} debugMode={debugMode} onHandPosition={setHandPosition} isLightboxOpen={isLightboxOpen} />

      {/* Top Bar UI */}
      <div style={{ 
        position: 'absolute', 
        top: 0, 
        left: 0, 
        right: 0, 
        height: '80px', 
        zIndex: isLightboxOpen ? 1700 : 10, 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '0 24px', 
        pointerEvents: 'none',
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.4), transparent)'
      }}>
         {/* Left: Photo Manager */}
         <div style={{ pointerEvents: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <LinearButton onClick={toggleMusic}>
              {isMusicPlaying ? '音乐暂停' : '音乐播放'}
            </LinearButton>
            <LinearButton onClick={() => setShowPhotoManager(true)}>
              图片上传
            </LinearButton>
         </div>
         
         {/* Center: Title */}
         <div style={{ pointerEvents: 'auto' }}>
            <EditableTitle />
         </div>
         
         {/* Right: Controls */}
         <div style={{ pointerEvents: 'auto', display: 'flex', gap: '8px' }}>
            <LinearButton onClick={() => setShowGestureGuide(true)}>
              手势说明
            </LinearButton>
            <LinearButton onClick={() => setDebugMode(!debugMode)} active={debugMode}>
               {debugMode ? '隐藏调试' : '展示调试'}
            </LinearButton>
         </div>
      </div>

      {/* Modals */}
      {showPhotoManager && <PhotoManager photos={photos} onClose={() => setShowPhotoManager(false)} onUpdate={fetchPhotos} />}
      {showGestureGuide && <GestureGuide onClose={() => setShowGestureGuide(false)} />}

      {/* Lightbox Modal */}
      {isLightboxOpen && lightboxPhotoIndex !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            pointerEvents: 'none',
            opacity: lightboxOpacity,
            transition: 'opacity 0.4s ease-in-out',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ClassicFireworksBackdrop active={true} opacity={lightboxOpacity} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.8) 100%)'
            }}
          />
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              animation: 'fadeIn 0.3s ease-in-out'
            }}
          >
            <img
              src={photos[lightboxPhotoIndex] || ''}
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

      {/* Background Music */}
      <audio
        ref={audioRef}
        src={asset('BGM.mp3')}
        loop
        preload="auto"
      />
    </div>
  );
}

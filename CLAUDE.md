# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an interactive 3D Christmas tree web application built with React, Three.js (via React Three Fiber), and AI gesture recognition. The tree consists of 45,000+ glowing particles, floating Polaroid-style photos, dynamic fairy lights, Christmas decorations, and various visual effects. Users can control the tree through hand gestures detected via webcam using MediaPipe's AI vision library.

## Development Commands

```bash
# Install dependencies
npm install

# Start development server (runs at http://localhost:5173)
npm run dev

# Build for production
npm run build

# Lint code
npm run lint

# Preview production build
npm preview
```

## Core Architecture

### Main Application Structure

The entire application is contained in `src/App.tsx` with the following component hierarchy:

1. **GrandTreeApp** (Root Component)
   - Manages global state: `sceneState` ('CHAOS' | 'FORMED'), `rotationSpeed`, `aiStatus`, `debugMode`
   - Renders the Canvas and UI controls
   - Integrates GestureController

2. **Experience** (Main 3D Scene)
   - Configures Three.js scene: camera, lighting, environment, post-processing
   - Orchestrates all 3D components
   - Manages auto-rotation and OrbitControls based on gesture input

3. **Core 3D Components** (all accept `state` prop):
   - **Foliage**: 25,000 emerald particles forming the tree body using custom shader material
   - **PhotoOrnaments**: 400 double-sided Polaroid photos with dynamic positioning and wobble effects
   - **ChristmasElements**: 500 gifts, ornaments, and candy canes
   - **FairyLights**: 800 blinking colored lights
   - **TopStar**: 3D gold star at tree top (pure 3D extruded geometry, no photo texture)
   - **FireworkParticles**: Particle effect triggered when tree transitions to FORMED state
   - **PhotoConfetti**: Particle effect triggered when photo is opened via pinch gesture

4. **GestureController** (AI Integration)
   - Uses MediaPipe Gesture Recognizer for hand tracking
   - Detects "Open_Palm" (disperse) and "Closed_Fist" (assemble) gestures
   - Calculates rotation speed based on hand horizontal position
   - Detects pinch gestures for photo viewing
   - Provides hand position tracking for future interaction features

5. **Audio System**
   - Background music integration with play/pause control
   - Audio element with looping Christmas music from CDN
   - UI toggle button in top-right corner

### Key Technical Patterns

**State-based Animation System**:
All 3D components transition between two states:
- `CHAOS`: Elements scattered randomly in a large sphere
- `FORMED`: Elements positioned to form a conical Christmas tree shape

Each component stores both `chaosPos` and `targetPos`, then lerps between them based on the current state. This creates smooth, coordinated transitions.

**Custom Shader Material for Foliage**:
The `FoliageMaterial` uses a custom vertex/fragment shader extending Three.js ShaderMaterial:
- Vertex shader: Handles position interpolation and point sizing
- Fragment shader: Creates circular particles with color mixing
- Uses `uProgress` uniform (0-1) to control CHAOS↔FORMED transition

**Photo System Architecture**:
- Photos are loaded from `public/photos/` directory
- `top.jpg` is now included in the body photos array (line 22-25 in App.tsx)
- Body photos: `1.jpg` through `31.jpg` (configurable via `TOTAL_NUMBERED_PHOTOS`)
- Each photo is rendered as double-sided Polaroid with:
  - Front/back face with same texture
  - Colored border frame (random from `CONFIG.colors.borders`)
  - Emissive material for glow effect
  - Automatic lookAt camera when formed
  - Wobble animation using sine/cosine functions

**Tree Geometry Generation**:
The `getTreePosition()` helper function generates positions forming a conical tree shape:
- Y-axis: Random height within tree bounds
- Radius: Decreases linearly from base to top
- X/Z: Polar coordinates (random radius and angle)

## Configuration System

All visual parameters are centralized in the `CONFIG` object (lines 28-55):

```typescript
const CONFIG = {
  colors: { ... },      // All color schemes
  counts: {
    foliage: 25000,     // Particle count (performance-sensitive)
    ornaments: 400,     // Polaroid photos
    elements: 500,      // Gifts/decorations
    lights: 800         // Fairy lights
  },
  tree: { height: 32, radius: 13 }, // Tree dimensions
  photos: { body: [...] }            // Photo paths array
}
```

## Customizing Photos

To change the number of photos displayed:

1. Add/remove photo files in `public/photos/` (maintain `1.jpg`, `2.jpg`, ... naming)
2. Update `TOTAL_NUMBERED_PHOTOS` constant (line 20)
3. The `bodyPhotoPaths` array auto-generates based on this value

The system automatically cycles through available textures if `CONFIG.counts.ornaments` exceeds photo count (via `i % textures.length`).

## Performance Considerations

- **Particle Count**: `CONFIG.counts.foliage` directly impacts performance. Current default is 25,000 particles - this may impact performance on lower-end devices. Consider reducing to 15,000 for better performance.
- **Photo Loading**: All photos are preloaded via `useTexture()` hook before render
- **Shader Compilation**: First render may show brief lag while shaders compile
- **Post-Processing**: Bloom and Vignette effects add GPU overhead
- **Canvas DPR**: Limited to `[1, 2]` for performance (line 896)
- **Large Tree Dimensions**: Current dimensions (32 height x 13 radius) are larger than original design, requiring more render distance

## Gesture Recognition System

MediaPipe integration flow:
1. Downloads WebAssembly files and model from CDN on component mount
2. Requests camera permission
3. Runs gesture recognition on each video frame
4. Updates status messages shown in UI
5. Triggers state changes and rotation via callbacks
6. **Calculates pinch gesture (thumb + index finger distance)**

Recognized gestures:
- **Open_Palm**: Sets state to 'CHAOS' (tree disperses)
- **Closed_Fist**: Sets state to 'FORMED' (tree assembles)
- **Hand horizontal movement**: Controls rotation speed (-0.15 to +0.15 based on X position)
- **Pinch gesture (thumb + index)**: Opens nearest photo in lightbox (not random)

### Pinch Gesture Photo Viewing System

**Simple Interaction Flow**:
1. Pinch fingers (thumb + index) → Nearest photo to camera opens
2. Keep pinching → Photo stays open with fade-in effect
3. Release fingers → Photo fades out and closes automatically (400ms fade-out animation)

**Pinch Detection** (src/App.tsx:615-625):
- `GestureController` calculates 3D distance between thumb tip (landmark #4) and index tip (landmark #8)
- Formula: `distance = sqrt(dx² + dy² + dz²)`
- Threshold: `distance < 0.08` = pinching
- Passes `isPinching` boolean to parent component

**Nearest Photo Selection** (src/App.tsx:662-684):
- When `isPinching=true` AND not already open AND not already pinched → find nearest photo
- Calculates distance from camera to each photo using `camera.position.distanceTo(group.position)`
- Selects photo with minimum distance (closest to camera viewpoint)
- Opens lightbox immediately with fade-in effect
- `hasPinchedRef` prevents multiple triggers during single pinch
- Triggers confetti particle effect on photo open

**Release-to-Close Logic** (src/App.tsx:698-713):
- Continuously monitors `isPinching` state in `useFrame`
- When `isPinching=false` AND lightbox is open → starts fade-out animation
- Sets `lightboxOpacity` to 0, triggering CSS transition (400ms ease-out)
- After 400ms timeout, actually closes lightbox and clears state
- Resets `hasPinchedRef` flag when fingers released
- Uses `fadeOutTimerRef` to prevent multiple simultaneous fade-out timers
- No click handlers, pure gesture control

**Rotation Control**:
- Rotation pauses when `isLightboxOpen=true`
- Formula: `effectiveRotationSpeed = isLightboxOpen ? 0 : rotationSpeed`
- Hand rotation still works when lightbox closed

**Lightbox Display**:
- Shows full-size photo (50vh height) with golden glow shadow
- Hint text: "松开手指关闭 / Release to close"
- `pointerEvents: 'none'` - no mouse interaction needed
- Displays nearest selected photo from `CONFIG.photos.body` array
- Smooth fade-in/fade-out with CSS transition (400ms ease-out)
- Uses `lightboxOpacity` state managed via `setLightboxOpacity` (passed as prop to Experience)

**State Management**:
- `isLightboxOpen` - boolean, lightbox visibility (managed in both Experience and GrandTreeApp)
- `lightboxPhotoIndex` - number | null, which photo to show
- `lightboxOpacity` - number (0-1), controls CSS opacity for fade animations
- `hasPinchedRef` - ref, prevents re-triggering during same pinch
- `fadeOutTimerRef` - ref, manages fade-out timer to prevent overlapping animations
- All managed via `onLightboxStateChange` callback and `setLightboxOpacity` function

Debug mode renders hand landmarks overlay on video feed.

## Tech Stack Dependencies

- **React 18**: Core framework
- **Vite**: Build tool and dev server
- **Three.js**: WebGL 3D engine (v0.169.0)
- **@react-three/fiber**: React renderer for Three.js (declarative 3D)
- **@react-three/drei**: Helper components (OrbitControls, Environment, etc.)
- **@react-three/postprocessing**: Effects (Bloom, Vignette)
- **@mediapipe/tasks-vision**: AI hand gesture recognition
- **maath**: Math utilities for 3D (random point generation)

## Important Implementation Details

1. **Double-Sided Polaroids**: Each photo is rendered as two separate groups (front/back) with 180° rotation, not using `side: DoubleSide` to ensure proper emissive rendering on both sides.

2. **Animation Timing**: All components use `useFrame` hook for 60fps animations. Lerp/damp functions provide smooth transitions without explicit easing libraries.

3. **Texture Reuse**: The `useTexture` hook from drei handles texture caching and GPU upload automatically.

4. **Gesture Smoothing**: Rotation speed only applies when `Math.abs(speed) > 0.01` to prevent jitter when hand is centered.

5. **Coordinate System**: Three.js uses Y-up convention. Tree grows along positive Y axis, centered at origin.

6. **Tone Mapping**: Uses `ReinhardToneMapping` for HDR-like glow effects (line 896).

7. **Particle Effects System**: Two types of particle effects enhance visual feedback:
   - **FireworkParticles**: Gold/white particles that explode from tree top when transitioning from CHAOS to FORMED state
   - **PhotoConfetti**: Multi-colored confetti (gold/red/green/blue) that bursts when a photo is opened via pinch gesture
   - Both use physics simulation with gravity and have limited lifetimes (1.5-2 seconds)

8. **Known Issue - Missing State Setup**: The `Experience` component calls `setLightboxOpacity(1)` and `setLightboxOpacity(0)` (lines 682, 702) but this function is not defined in the component scope or passed as a prop. The `GrandTreeApp` does not declare a `lightboxOpacity` state or pass a `setLightboxOpacity` function. This will cause a runtime error. To fix: Add `const [lightboxOpacity, setLightboxOpacity] = useState(1)` in `GrandTreeApp` and pass `setLightboxOpacity` as a prop to `Experience`.

## File Organization

```
christmas-tree-1/
├── public/
│   └── photos/          # User-replaceable photos
│       ├── top.jpg      # (Now included in body array)
│       └── 1.jpg - 31.jpg
├── src/
│   ├── App.tsx          # Entire application (single file architecture)
│   └── main.tsx         # React entry point
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

The project intentionally uses a single-file architecture for the main application logic, keeping all components, shaders, and state management co-located in `App.tsx` for easier understanding and modification.

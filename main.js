import * as THREE from "three"

// --- シミュレーション設定 ---
const GRID_SIZE = 40 // グリッド解像度 (40x40)
const CELL_SIZE = 12.0 // 1マスの物理サイズ
const WORLD_W = GRID_SIZE * CELL_SIZE
const WORLD_H = GRID_SIZE * CELL_SIZE

const NUM_PARTICLES = 2000 //1200 // 粒子の数
const DT = 0.016
const GRAVITY = -200.0
const FLIP_RATIO = 0.95 // PICとFLIPのブレンド比率 (0.9 = ほぼFLIPでリッチな波を維持)

// --- データ構造 ---
// 粒子バッファ
const particlePos = new Float32Array(NUM_PARTICLES * 2)
const particleVel = new Float32Array(NUM_PARTICLES * 2)

// MACグリッド（速度 u:水平, v:垂直、圧力 p）
// 簡易的にセル中心・フェース上の速度を管理
const uGrid = new Float32Array((GRID_SIZE + 1) * GRID_SIZE)
const vGrid = new Float32Array(GRID_SIZE * (GRID_SIZE + 1))
const pGrid = new Float32Array(GRID_SIZE * GRID_SIZE)
const dGrid = new Float32Array(GRID_SIZE * GRID_SIZE) // 密度（粒子が存在するか）

// セルの種類 (0: AIR, 1: FLUID, 2: SOLID)
const CELL_AIR = 0
const CELL_FLUID = 1
const CELL_SOLID = 2
const cellType = new Uint8Array(GRID_SIZE * GRID_SIZE) // ←ここが抜けていました！

const margin_w = 0 // 100 から 0 に変更
const margin_h = 0 // 10 から 0 に変更

// --- 粒子の初期配置（壁から安全に離れた真ん中に、縦長の塊を作る） ---
let pIdx = 0
for (let i = 0; i < NUM_PARTICLES; i++) {
  // 水槽の横幅の中央を基準にするが、左右の壁（margin_w）からしっかり離す
  const minSpawnX = margin_w + 50
  const maxSpawnX = WORLD_W - margin_w - 50
  const centerRange = (maxSpawnX - minSpawnX) * 0.4 // 中央40%の幅に絞る

  const centerX = WORLD_W * 0.5
  const x = centerX + (Math.random() - 0.5) * centerRange

  // 高さは下部（marginの上）から中層にかけて配置
  const y = (Math.random() * 0.6 + 0.35) * WORLD_H

  particlePos[pIdx] = x
  particlePos[pIdx + 1] = y
  particleVel[pIdx] = 0
  particleVel[pIdx + 1] = 0
  pIdx += 2
}

// --- Three.js セットアップ ---
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a0a0f)

const camera = new THREE.OrthographicCamera(0, WORLD_W, WORLD_H, 0, 0.1, 1000)
camera.position.z = 100

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

// --- 水槽の壁（margin）の内側だけに背景プレートを配置 ---
const textureLoader = new THREE.TextureLoader()
const glassTexture = textureLoader.load("/glass.jpg")
glassTexture.colorSpace = THREE.SRGBColorSpace

const mSize = 3
const innerW = WORLD_W - margin_w * 2 + mSize / 2
const innerH = WORLD_H - margin_h * 2 + mSize / 2

const plateGeometry = new THREE.PlaneGeometry(innerW, innerH)
const plateMaterial = new THREE.MeshBasicMaterial({
  map: glassTexture, // ガラス画像を貼り付け
  color: 0x222222, // 水槽内の薄い背景色（青みのあるグレー）
  transparent: true,
  opacity: 1.0,
  depthWrite: false,
})
const backgroundPlate = new THREE.Mesh(plateGeometry, plateMaterial)

// プレートをワールドの中央に配置（Z=-1で奥に）
backgroundPlate.position.set(WORLD_W / 2, WORLD_H / 2, -1)
scene.add(backgroundPlate)

// 粒子描画用のバッファ（Three.jsは3次元位置を期待するのでパディング）
const renderPositions = new Float32Array(NUM_PARTICLES * 3)
const geometry = new THREE.BufferGeometry()
geometry.setAttribute("position", new THREE.BufferAttribute(renderPositions, 3))

const material = new THREE.PointsMaterial({
  size: mSize,
  color: 0x38bdf8,
  transparent: true,
  opacity: 0.9,
})

const particleSystem = new THREE.Points(geometry, material)
scene.add(particleSystem)

// --- シミュレーション設定に追加 ---
const TARGET_DENSITY = 6.0 // 1セルあたりの目標粒子数（これを超えると押し返す）
const DENSITY_STIFFNESS = 25.0 // 密度反発の強さ

function updateSimulation() {
  // 1. セルタイプの初期化（グリッドの最外周だけをSOLID、内部をAIRにする）
  for (let j = 0; j < GRID_SIZE; j++) {
    for (let i = 0; i < GRID_SIZE; i++) {
      const idx = i + j * GRID_SIZE
      // 最外周のセル（i=0, i=GRID_SIZE-1, j=0, j=GRID_SIZE-1）をSOLIDにする
      if (i === 0 || i === GRID_SIZE - 1 || j === 0 || j === GRID_SIZE - 1) {
        cellType[idx] = CELL_SOLID
      } else {
        cellType[idx] = CELL_AIR
      }
    }
  }

  // 2. 粒子が存在するセルを FLUID に設定 & セルごとの粒子数（密度）をカウント
  const densityGrid = new Float32Array(GRID_SIZE * GRID_SIZE)
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const gx = Math.floor(particlePos[i * 2] / CELL_SIZE)
    const gy = Math.floor(particlePos[i * 2 + 1] / CELL_SIZE)
    if (gx >= 0 && gx < GRID_SIZE && gy >= 0 && gy < GRID_SIZE) {
      const idx = gx + gy * GRID_SIZE
      densityGrid[idx] += 1.0 // 粒子数をカウント
      if (cellType[idx] !== CELL_SOLID) {
        cellType[idx] = CELL_FLUID
      }
    }
  }

  // 3. P2G (Particle to Grid) ... (既存と同じ)
  uGrid.fill(0)
  vGrid.fill(0)
  const weightU = new Float32Array(uGrid.length)
  const weightV = new Float32Array(vGrid.length)

  for (let i = 0; i < NUM_PARTICLES; i++) {
    const x = particlePos[i * 2]
    const y = particlePos[i * 2 + 1]
    const vx = particleVel[i * 2]
    const vy = particleVel[i * 2 + 1]

    const gxU = x / CELL_SIZE,
      gyU = y / CELL_SIZE - 0.5
    const iu0 = Math.floor(gxU),
      ju0 = Math.floor(gyU)
    const txU = gxU - iu0,
      tyU = gyU - ju0

    for (let j = 0; j <= 1; j++) {
      for (let i_ = 0; i_ <= 1; i_++) {
        const u_i = iu0 + i_,
          u_j = ju0 + j
        if (u_i >= 0 && u_i <= GRID_SIZE && u_j >= 0 && u_j < GRID_SIZE) {
          const w = (i_ === 0 ? 1 - txU : txU) * (j === 0 ? 1 - tyU : tyU)
          const idx = u_i + u_j * (GRID_SIZE + 1)
          uGrid[idx] += vx * w
          weightU[idx] += w
        }
      }
    }

    const gxV = x / CELL_SIZE - 0.5,
      gyV = y / CELL_SIZE
    const iv0 = Math.floor(gxV),
      jv0 = Math.floor(gyV)
    const txV = gxV - iv0,
      tyV = gyV - jv0

    for (let j = 0; j <= 1; j++) {
      for (let i_ = 0; i_ <= 1; i_++) {
        const v_i = iv0 + i_,
          v_j = jv0 + j
        if (v_i >= 0 && v_i < GRID_SIZE && v_j >= 0 && v_j <= GRID_SIZE) {
          const w = (i_ === 0 ? 1 - txV : txV) * (j === 0 ? 1 - tyV : tyV)
          const idx = v_i + v_j * GRID_SIZE
          vGrid[idx] += vy * w
          weightV[idx] += w
        }
      }
    }
  }

  for (let i = 0; i < uGrid.length; i++)
    if (weightU[i] > 0) uGrid[i] /= weightU[i]
  for (let i = 0; i < vGrid.length; i++)
    if (weightV[i] > 0) vGrid[i] /= weightV[i]

  // 4. 外力（重力）の適用
  for (let j = 0; j <= GRID_SIZE; j++) {
    for (let i = 0; i < GRID_SIZE; i++) {
      vGrid[i + j * GRID_SIZE] += GRAVITY * DT
    }
  }

  // 5. 圧力ソルバー (密度補正付き Projection)
  pGrid.fill(0)
  const iterations = 80

  for (let iter = 0; iter < iterations; iter++) {
    for (let j = 1; j < GRID_SIZE - 1; j++) {
      for (let i = 1; i < GRID_SIZE - 1; i++) {
        const idx = i + j * GRID_SIZE
        if (cellType[idx] !== CELL_FLUID) continue

        const leftType = cellType[i - 1 + j * GRID_SIZE]
        const rightType = cellType[i + 1 + j * GRID_SIZE]
        const bottomType = cellType[i + (j - 1) * GRID_SIZE]
        const topType = cellType[i + (j + 1) * GRID_SIZE]

        const uL = uGrid[i + j * (GRID_SIZE + 1)]
        const uR = uGrid[i + 1 + j * (GRID_SIZE + 1)]
        const vB = vGrid[i + j * GRID_SIZE]
        const vT = vGrid[i + (j + 1) * GRID_SIZE]

        // 速度の発散 (Velocity Divergence)
        let div = (uR - uL + vT - vB) / CELL_SIZE

        // ★【核心部】密度過密による圧力補正項を追加
        // 粒子数が目標を超えている場合、発散を人工的に増やして強烈な押し返す力を生む
        const density = densityGrid[idx]
        if (density > TARGET_DENSITY) {
          const compression = (density - TARGET_DENSITY) / TARGET_DENSITY
          div -= compression * DENSITY_STIFFNESS
        }

        let denom = 0
        if (leftType !== CELL_SOLID) denom += 1
        if (rightType !== CELL_SOLID) denom += 1
        if (bottomType !== CELL_SOLID) denom += 1
        if (topType !== CELL_SOLID) denom += 1

        if (denom === 0) continue

        const pUpdate = -div / denom
        pGrid[idx] += pUpdate

        if (leftType !== CELL_SOLID) uGrid[i + j * (GRID_SIZE + 1)] -= pUpdate
        if (rightType !== CELL_SOLID)
          uGrid[i + 1 + j * (GRID_SIZE + 1)] += pUpdate
        if (bottomType !== CELL_SOLID) vGrid[i + j * GRID_SIZE] -= pUpdate
        if (topType !== CELL_SOLID) vGrid[i + (j + 1) * GRID_SIZE] += pUpdate
      }
    }
  }

  // 6. Solid境界での速度ゼロ固定 (滑りなし壁)
  for (let j = 0; j <= GRID_SIZE; j++) {
    uGrid[0 + j * (GRID_SIZE + 1)] = 0
    uGrid[GRID_SIZE + j * (GRID_SIZE + 1)] = 0
  }
  for (let i = 0; i < GRID_SIZE; i++) {
    vGrid[i + 0 * GRID_SIZE] = 0
    vGrid[i + GRID_SIZE * GRID_SIZE] = 0
  }

  // 7. G2P & 位置の更新
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const x = particlePos[i * 2]
    const y = particlePos[i * 2 + 1]
    const oldVx = particleVel[i * 2]
    const oldVy = particleVel[i * 2 + 1]

    // 速度補間 (端のセルでもクランプして帯状の抜けを防ぐ)
    const gxU = x / CELL_SIZE,
      gyU = y / CELL_SIZE - 0.5
    const iu = Math.min(Math.max(Math.floor(gxU), 0), GRID_SIZE - 1)
    const ju = Math.min(Math.max(Math.floor(gyU), 0), GRID_SIZE - 1)
    const txU = Math.min(Math.max(gxU - iu, 0), 1)
    const tyU = Math.min(Math.max(gyU - ju, 0), 1)

    let newVx = 0
    if (iu >= 0 && iu < GRID_SIZE && ju >= 0 && ju < GRID_SIZE) {
      const u00 = uGrid[iu + ju * (GRID_SIZE + 1)]
      const u10 = uGrid[iu + 1 + ju * (GRID_SIZE + 1)]
      const u01 = uGrid[iu + (ju + 1) * (GRID_SIZE + 1)]
      const u11 = uGrid[iu + 1 + (ju + 1) * (GRID_SIZE + 1)]
      newVx =
        (1 - txU) * (1 - tyU) * u00 +
        txU * (1 - tyU) * u10 +
        (1 - txU) * tyU * u01 +
        txU * tyU * u11
    }

    const gxV = x / CELL_SIZE - 0.5,
      gyV = y / CELL_SIZE
    const iv = Math.min(Math.max(Math.floor(gxV), 0), GRID_SIZE - 1)
    const jv = Math.min(Math.max(Math.floor(gyV), 0), GRID_SIZE - 1)
    const txV = Math.min(Math.max(gxV - iv, 0), 1)
    const tyV = Math.min(Math.max(gyV - jv, 0), 1)

    let newVy = 0
    if (iv >= 0 && iv < GRID_SIZE && jv >= 0 && jv < GRID_SIZE) {
      const v00 = vGrid[iv + jv * GRID_SIZE]
      const v10 = vGrid[iv + 1 + jv * GRID_SIZE]
      const v01 = vGrid[iv + (jv + 1) * GRID_SIZE]
      const v11 = vGrid[iv + 1 + (jv + 1) * GRID_SIZE]
      newVy =
        (1 - txV) * (1 - tyV) * v00 +
        txV * (1 - tyV) * v10 +
        (1 - txV) * tyV * v01 +
        txV * tyV * v11
    }

    const picVx = newVx,
      picVy = newVy
    const flipVx = oldVx + (newVx - oldVx)
    const flipVy = oldVy + (newVy - oldVy)

    particleVel[i * 2] = FLIP_RATIO * flipVx + (1 - FLIP_RATIO) * picVx
    particleVel[i * 2 + 1] = FLIP_RATIO * flipVy + (1 - FLIP_RATIO) * picVy

    // ★ここに速度の減衰（ダンピング）を追加する！
    // particleVel[i * 2] *= 0.98
    // particleVel[i * 2 + 1] *= 0.98

    particlePos[i * 2] += particleVel[i * 2] * DT
    particlePos[i * 2 + 1] += particleVel[i * 2 + 1] * DT

    // 実際の壁の位置（マージンそのもの）
    const minX = margin_w
    const maxX = WORLD_W - margin_w
    const minY = margin_h
    const maxY = WORLD_H - margin_h

    // 壁に到達した瞬間に確実に固定し、隙間を作らない
    if (particlePos[i * 2] < minX) {
      particlePos[i * 2] = minX
      particleVel[i * 2] = 0
    }
    if (particlePos[i * 2] > maxX) {
      particlePos[i * 2] = maxX
      particleVel[i * 2] = 0
    }
    if (particlePos[i * 2 + 1] < minY) {
      particlePos[i * 2 + 1] = minY
      particleVel[i * 2 + 1] = 0
    }
    if (particlePos[i * 2 + 1] > maxY) {
      particlePos[i * 2 + 1] = maxY
      particleVel[i * 2 + 1] = 0
    }

    renderPositions[i * 3] = particlePos[i * 2]
    renderPositions[i * 3 + 1] = particlePos[i * 2 + 1]
    renderPositions[i * 3 + 2] = 0
  }

  particleSystem.geometry.attributes.position.needsUpdate = true
}

// --- メインループ ---
function animate() {
  requestAnimationFrame(animate)
  updateSimulation()
  renderer.render(scene, camera)
}

animate()

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
})

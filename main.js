import * as THREE from "three"

// --- シミュレーション設定 ---
const GRID_SIZE = 40 // グリッド解像度 (40x40)
const CELL_SIZE = 12.0 // 1マスの物理サイズ
const WORLD_W = GRID_SIZE * CELL_SIZE
const WORLD_H = GRID_SIZE * CELL_SIZE

const NUM_PARTICLES = 1200 //1200 // 粒子の数
const DT = 0.016
const GRAVITY = -200.0
const FLIP_RATIO = 0.9 // PICとFLIPのブレンド比率 (0.9 = ほぼFLIPでリッチな波を維持)

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

// --- 粒子の初期配置（左側に水塊を作る） ---
let pIdx = 0
for (let i = 0; i < NUM_PARTICLES; i++) {
  // 左側のエリアにランダムに配置
  const x = (Math.random() * 0.3 + 0.1) * WORLD_W
  const y = (Math.random() * 0.6 + 0.2) * WORLD_H

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
const margin_w = 100
const margin_h = 10
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

// --- PIC/FLIP のコア処理ステップ ---
function updateSimulation() {
  // 1. グリッドの初期化
  uGrid.fill(0)
  vGrid.fill(0)
  pGrid.fill(0)
  dGrid.fill(0)

  // 2. Particle to Grid (P2G): 粒子の速度と質量をグリッドに転写
  // 線形補間（LERP）を用いて周囲のグリッドセルに速度を分配
  const weightGridU = new Float32Array(uGrid.length)
  const weightGridV = new Float32Array(vGrid.length)

  for (let i = 0; i < NUM_PARTICLES; i++) {
    const x = particlePos[i * 2]
    const y = particlePos[i * 2 + 1]
    const vx = particleVel[i * 2]
    const vy = particleVel[i * 2 + 1]

    // グリッド座標への変換
    const gx = x / CELL_SIZE
    const gy = y / CELL_SIZE

    const i0 = Math.floor(gx)
    const j0 = Math.floor(gy)

    if (i0 >= 0 && i0 < GRID_SIZE - 1 && j0 >= 0 && j0 < GRID_SIZE - 1) {
      const tx = gx - i0
      const ty = gy - j0

      // 重み配分 (Bilinear)
      // Uグリッドへの転写
      const uIdx = i0 + j0 * (GRID_SIZE + 1)
      uGrid[uIdx] += vx * (1 - tx) * (1 - ty)
      weightGridU[uIdx] += (1 - tx) * (1 - ty)
      uGrid[uIdx + 1] += vx * tx * (1 - ty)
      weightGridU[uIdx + 1] += tx * (1 - ty)

      // Vグリッドへの転写
      const vIdx = i0 + j0 * GRID_SIZE
      vGrid[vIdx] += vy * (1 - tx) * (1 - ty)
      weightGridV[vIdx] += (1 - tx) * (1 - ty)
      vGrid[vIdx + GRID_SIZE] += vy * (1 - tx) * ty
      weightGridV[vIdx + GRID_SIZE] += (1 - tx) * ty

      // 密度グリッドの更新
      dGrid[i0 + j0 * GRID_SIZE] += 1.0
    }
  }

  // 速度を重みで割る（平均化）
  for (let i = 0; i < uGrid.length; i++) {
    if (weightGridU[i] > 0) uGrid[i] /= weightGridU[i]
  }
  for (let i = 0; i < vGrid.length; i++) {
    if (weightGridV[i] > 0) vGrid[i] /= weightGridV[i]
  }

  // 3. 外力（重力）の適用
  for (let j = 0; j < GRID_SIZE + 1; j++) {
    for (let i = 0; i < GRID_SIZE; i++) {
      vGrid[i + j * GRID_SIZE] += GRAVITY * DT
    }
  }

  // 4. 圧力ソルバー (Poisson Equation / ヤコビ法による非圧縮化)
  // 水が潰れないように、速度の発散（わき出し）を相殺する圧力を計算
  const iterations = 15
  for (let iter = 0; iter < iterations; iter++) {
    for (let j = 1; j < GRID_SIZE - 1; j++) {
      for (let i = 1; i < GRID_SIZE - 1; i++) {
        const idx = i + j * GRID_SIZE
        if (dGrid[idx] === 0) continue // 流体がない場所はスキップ

        // 発散 (Divergence) の計算
        const div =
          (uGrid[i + 1 + j * (GRID_SIZE + 1)] -
            uGrid[i + j * (GRID_SIZE + 1)] +
            vGrid[i + (j + 1) * GRID_SIZE] -
            vGrid[i + j * GRID_SIZE]) /
          CELL_SIZE

        // 圧力を更新して発散を打ち消す
        const pUpdate = -div * 0.5
        pGrid[idx] += pUpdate

        // 速度場を圧力勾配で補正
        uGrid[i + j * (GRID_SIZE + 1)] -= pUpdate
        uGrid[i + 1 + j * (GRID_SIZE + 1)] += pUpdate
        vGrid[i + j * GRID_SIZE] -= pUpdate
        vGrid[i + (j + 1) * GRID_SIZE] += pUpdate
      }
    }
  }

  // 5. Grid to Particle (G2P) & 粒子位置の更新 (PIC / FLIP ブレンド)
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const x = particlePos[i * 2]
    const y = particlePos[i * 2 + 1]
    const oldVx = particleVel[i * 2]
    const oldVy = particleVel[i * 2 + 1]

    // グリッドから新しい速度を補間取得
    const gx = x / CELL_SIZE
    const gy = y / CELL_SIZE
    const i0 = Math.floor(gx)
    const j0 = Math.floor(gy)

    if (i0 >= 0 && i0 < GRID_SIZE - 1 && j0 >= 0 && j0 < GRID_SIZE - 1) {
      const tx = gx - i0
      const ty = gy - j0

      // 速度のサンプリング (簡易補間)
      const uIdx = i0 + j0 * (GRID_SIZE + 1)
      const vIdx = i0 + j0 * GRID_SIZE

      const newVx = uGrid[uIdx] * (1 - tx) + uGrid[uIdx + 1] * tx
      const newVy = vGrid[vIdx] * (1 - ty) + vGrid[vIdx + GRID_SIZE] * ty

      // FLIPとPICのブレンド
      // FLIP: 速度の変化分を維持するので、水の波や生き生きとしたうねりが生まれる
      const picVelX = newVx
      const picVelY = newVy
      const flipVelX = oldVx + (newVx - oldVx)
      const flipVelY = oldVy + (newVy - oldVy)

      particleVel[i * 2] = FLIP_RATIO * flipVelX + (1 - FLIP_RATIO) * picVelX
      particleVel[i * 2 + 1] =
        FLIP_RATIO * flipVelY + (1 - FLIP_RATIO) * picVelY
    }

    // 位置の更新
    particlePos[i * 2] += particleVel[i * 2] * DT
    particlePos[i * 2 + 1] += particleVel[i * 2 + 1] * DT

    // 壁の衝突処理 (バウンダリ)
    // const margin_w = 100
    // const margin_h = 10
    if (particlePos[i * 2] < margin_w) {
      particlePos[i * 2] = margin_w
      particleVel[i * 2] *= -0.5
    }
    if (particlePos[i * 2] > WORLD_W - margin_w) {
      particlePos[i * 2] = WORLD_W - margin_w
      particleVel[i * 2] *= -0.5
    }
    if (particlePos[i * 2 + 1] < margin_h) {
      particlePos[i * 2 + 1] = margin_h
      particleVel[i * 2 + 1] *= -0.5
    }
    if (particlePos[i * 2 + 1] > WORLD_H - margin_h) {
      particlePos[i * 2 + 1] = WORLD_H - margin_h
      particleVel[i * 2 + 1] *= -0.5
    }

    // 描画バッファへ反映
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

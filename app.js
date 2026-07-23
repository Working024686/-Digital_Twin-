/* =========================================================================
 * DIGITAL TWIN VIEWER — MAIN APPLICATION SCRIPT (app.js)
 * -------------------------------------------------------------------------
 * 本檔案負責處理工廠機械臂工作站的數位雙生 (Digital Twin) 運作邏輯，包含：
 *   1. 傳送帶 (Conveyor) 與機械臂 (Robot) 的有限狀態機 (FSM) 狀態模擬與資料模型
 *   2. 模擬後端與通訊抽象層 (ApiClient)
 *   3. WebGL 3D 視覺渲染與運動學同步 (Three.js RobotScene)
 *   4. UI 即時遙測數據 (Telemetry) 更新、Sparklines 圖表繪製與事件紀錄器 (Event Log)
 *   5. 相機二維儀表板層 (Camera HUD Canvas)
 * 
 * 為了方便後續進行模組化拆分與整合，本檔案已清晰劃分為以下六大區域。
 * ========================================================================= */


/* =========================================================================
 * 區域 1：狀態模擬與狀態機 (STATE SIMULATION & FSM)
 * -------------------------------------------------------------------------
 * 職責：
 *   - 模擬實際硬體/後端的運行狀態。
 *   - ConveyorFSM：模擬工件從進料、定位、掃描加工、出料到空料的循環狀態。
 *   - RobotFSM：根據傳送帶的狀態決定機械臂各關節 (J1-J6) 的目標運動角度。
 *   - StateManager：定時更新所有物理與感知數據（如馬達溫度、震動度、關節坐標等），
 *     並包裝為對齊 API 規範的統一 JSON 資料模型。
 * ========================================================================= */

// --- 1.1 傳送帶有限狀態機 (Conveyor FSM) ---
const ConveyorFSM = (() => {
  const STATES = ["WAIT_WORKPIECE", "ARRIVING", "SCANNING", "DEPARTING", "WAIT_NEXT"];
  let stateIdx = 0;
  let cycle = 1234;
  let t = 0;

  const eventSubs = [];
  function emitEvent(kind, title, desc) {
    eventSubs.forEach(fn => fn({ kind, title, desc, time: new Date() }));
  }

  // 狀態循環切換
  function stepStateMachine() {
    const prev = STATES[stateIdx];
    stateIdx = (stateIdx + 1) % STATES.length;
    const cur = STATES[stateIdx];
    if (cur === "ARRIVING" && prev === "WAIT_NEXT") {
      cycle += 1;
      emitEvent("state", "Conveyor: New Cycle", `Cycle #${cycle} — workpiece entering station`);
    } else {
      emitEvent("state", "Conveyor: " + cur, describeState(cur));
    }
  }

  function describeState(s) {
    switch (s) {
      case "WAIT_WORKPIECE": return "Conveyor idle — waiting for next workpiece";
      case "ARRIVING": return "Workpiece detected — conveyor moving to station";
      case "SCANNING": return "Workpiece stopped at station — robot scanning";
      case "DEPARTING": return "Processing complete — workpiece leaving station";
      case "WAIT_NEXT": return "Conveyor reset — preparing for next cycle";
      default: return "";
    }
  }

  // 各狀態持續時間 (毫秒)
  const STATE_DURATION = { WAIT_WORKPIECE: 1200, ARRIVING: 1500, SCANNING: 2500, DEPARTING: 1500, WAIT_NEXT: 800 };
  let stateClock = 0;

  function getWorkpiecePresent() {
    const cur = STATES[stateIdx];
    return cur !== "WAIT_WORKPIECE" && cur !== "WAIT_NEXT";
  }

  emitEvent("system", "System Boot", "Conveyor initialized");
  setTimeout(() => emitEvent("state", "Ready", "Conveyor ready for workpiece"), 400);

  function tick(dtMs) {
    t += dtMs;
    stateClock += dtMs;
    const dur = STATE_DURATION[STATES[stateIdx]];
    if (stateClock >= dur) {
      stateClock = 0;
      stepStateMachine();
    }
  }

  // 以 80ms 為一個 Step 定期驅動傳送帶狀態機
  setInterval(() => tick(80), 80);

  function getState() {
    return {
      conveyorState: STATES[stateIdx],
      workpiecePresent: getWorkpiecePresent(),
      cycle: cycle,
      stateClock: stateClock
    };
  }

  // 註冊訂閱函數以監聽傳送帶事件
  function onEvent(fn) { eventSubs.push(fn); }

  return { getState, onEvent };
})();


// --- 1.2 機械手臂有限狀態機 (Robot FSM) ---
const RobotFSM = (() => {
  // 關節初始角度配置 (J1 ~ J6, degrees)
  let currentJoints = [0, -20, -40, 0, -60, 0];
  let eventSubs = [];

  function emitEvent(kind, title, desc) {
    eventSubs.forEach(fn => fn({ kind, title, desc, time: new Date() }));
  }

  // 根據傳送帶的狀態獲取對應的目標關節姿態 (Kinematic Targets)
  function getRobotMoveForConveyorState(conveyorState) {
    switch (conveyorState) {
      case "WAIT_WORKPIECE":
        return { joints: [0, -20, -50, 0, -60, 0], desc: "Standby Idle" };
      case "ARRIVING":
        return { joints: [0, -10, -95, 0, -70, 0], desc: "Approaching Workpiece" };
      case "SCANNING":
        return { joints: [0, -5, -95, 0, -65, 0], desc: "Scanning Workpiece at Station" };
      case "DEPARTING":
        return { joints: [0, -10, -85, 0, -60, 0], desc: "Lifting & Releasing" };
      case "WAIT_NEXT":
        return { joints: [0, -20, -50, 0, -60, 0], desc: "Resetting to Ready" };
      default:
        return { joints: currentJoints, desc: "Unknown" };
    }
  }

  let lastConveyorState = null;
  function updateForConveyorState(conveyorState) {
    const move = getRobotMoveForConveyorState(conveyorState);
    // 使用平滑插值 (Lerp) 趨近目標姿態
    currentJoints = currentJoints.map((j, i) => j + (move.joints[i] - j) * 0.08);

    // 狀態變更時發送通知事件給 Event Log
    if (conveyorState !== lastConveyorState) {
      lastConveyorState = conveyorState;
      emitEvent("state", "Robot: " + move.desc, "Robot arm responding to conveyor state: " + conveyorState);
    }
  }

  function getState() {
    return {
      joints: currentJoints.slice(),
      tcp: { x: 320, y: 0, z: 410, rx: 0, ry: 0, rz: currentJoints[5] } // 模擬末端工具中心點 TCP 數據
    };
  }

  // 註冊訂閱函數以監聽機械臂事件
  function onEvent(fn) { eventSubs.push(fn); }

  return { updateForConveyorState, getState, onEvent };
})();


// --- 1.3 整合狀態管理器 (State Manager) ---
const StateManager = (() => {
  let t = 0;

  function tick(dtMs) {
    t += dtMs;

    // 1. 取得傳送帶狀態
    const conveyorState = ConveyorFSM.getState();

    // 2. 更新並取得機械手臂狀態
    RobotFSM.updateForConveyorState(conveyorState.conveyorState);
    const robotState = RobotFSM.getState();

    // 3. 模擬雜訊波動產生的馬達與遙測數據 (Telemetry)
    const speed = 300 + Math.sin(t / 900) * 110 + (Math.random() - 0.5) * 20;
    const accel = 120 + Math.cos(t / 700) * 60 + (Math.random() - 0.5) * 15;
    const vibration = 0.03 + Math.abs(Math.sin(t / 500)) * 0.02 + Math.random() * 0.005;
    const motorTemp = 42 + Math.sin(t / 4000) * 6;
    const motorCurrent = 1.8 + Math.cos(t / 3000) * 0.6;
    const currentCameraMode = (typeof CameraSimulator !== "undefined" && CameraSimulator.getMode) ? CameraSimulator.getMode() : "onhand";

    // 4. 包裝並回傳標準資料模型 (對齊 Chapter 8/9 Data Schema)
    return {
      schemaVersion: "1.0",
      timestamp: Date.now(),
      system: {
        timestamp: new Date().toISOString(),
        connectionStatus: "online",
        latencyMs: 20 + Math.round(Math.random() * 15)
      },
      robot: {
        mode: "RUNNING",
        state: conveyorState.conveyorState,
        cycle: conveyorState.cycle,
        joint: robotState.joints,
        joints: robotState.joints,
        tcp: robotState.tcp,
        speed: Math.max(0, speed),
        accel
      },
      conveyor: {
        state: conveyorState.conveyorState,
        stateClock: conveyorState.stateClock,
        workpiece: {
          id: conveyorState.cycle,
          position: { x: 200, y: 0, z: 0 },
          status: conveyorState.workpiecePresent ? "present" : "absent"
        }
      },
      workpiece: {
        position: { x: 200, y: 0, z: 0 },
        status: conveyorState.workpiecePresent ? "present" : "absent"
      },
      telemetry: {
        speed: Math.max(0, speed),
        acceleration: accel,
        vibration: vibration,
        motor_temperature: motorTemp,
        motor_current: motorCurrent
      },
      trend: { vibration, motorTemp, motorCurrent },
      camera: {
        mode: currentCameraMode
      },
      eventVersion: 1,
      routeVersion: 1
    };
  }

  // 定期更新本機資料模型並推播給 API Client
  setInterval(() => {
    ApiClient._updateState(tick(80));
  }, 80);

  return { tick };
})();


/* =========================================================================
 * 區域 2：API 暨通訊抽象層 (API CLIENT)
 * -------------------------------------------------------------------------
 * 職責：
 *   - 本地前端 UI、Three.js 與狀態訂閱的唯一資料來源。
 *   - 採用訂閱者模式 (onUpdate) 將最新狀態分發至主場景渲染器與 UI 圖表。
 *   - 當後續需要對接真實後端 API 時，僅需關閉本機 Mock 資料源並在此實現 fetch/WebSocket。
 * ========================================================================= */

const ApiClient = (() => {
  let latestState = null;
  let listeners = [];

  // 由內部仿真器或外部 WebSocket 呼叫更新狀態
  function _updateState(data) {
    latestState = data;
    listeners.forEach(fn => fn(data));
  }

  function start() {
    // 預留對接真實後端輪詢/WebSocket 之啟動端點
  }

  function onUpdate(fn) { listeners.push(fn); }
  function getLatestState() { return latestState; }

  return { start, onUpdate, getLatestState, _updateState };
})();


/* =========================================================================
 * 區域 3：3D 視覺渲染與運動學同步 (THREE.JS DIGITAL TWIN)
 * -------------------------------------------------------------------------
 * 職責：
 *   - 程序化建模 (Procedural Modeling) 機械手臂和間歇式輸送帶。
 *   - 初始化 WebGL Renderer 渲染主 3D 視角。
 *   - 初始化 CameraRenderer 用於輸出 Camera 面板的 3D 畫面。
 *   - 在機械手臂 J6 末端上掛載真實 FPV 相機 (onHandCamera)。
 *   - 於繪圖更新循環 (updateFrame) 中：
 *     1. 驅動關節旋轉 (Degrees to Radians, 運動學角度同步)。
 *     2. 根據時間戳動態平滑插值工件在傳送帶 (Z軸) 上的位移，模擬進料/停靠/出料。
 * ========================================================================= */

const RobotScene = (() => {
  let renderer, scene, camera, controls;
  let cameraRenderer, onHandCamera, globalViewCamera;
  let jointGroups = []; // 各關節層級 nested THREE.Group [j1..j6]
  let currentAngles = [0, 0, 0, 0, 0, 0];
  let fromAngles = [0, 0, 0, 0, 0, 0];
  let toAngles = [0, 0, 0, 0, 0, 0];
  let lerpT = 1;
  const LERP_DURATION = 150;

  // 材質庫
  const metal = (hex, rough = 0.4, metal_ = 0.6) => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal_ });
  const MAT_ARM = metal(0xd8dce2, 0.45, 0.35);
  const MAT_JOINT = metal(0x2a3140, 0.5, 0.6);
  const MAT_BASE = metal(0x232a36, 0.5, 0.5);
  const MAT_TABLE = metal(0x3a4250, 0.6, 0.3);
  const MAT_PART = new THREE.MeshStandardMaterial({ color: 0x4DA3FF, roughness: 0.3, metalness: 0.2 });

  // 初始化 WebGL 場景與控制器
  function init(container) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0F131A);
    scene.fog = new THREE.Fog(0x0F131A, 12, 30);

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(6, 5, 7);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // 二次 WebGL 渲染器 (Camera 面板)
    const cameraCanvasEl = document.getElementById("cameraCanvas");
    if (cameraCanvasEl) {
      cameraRenderer = new THREE.WebGLRenderer({ canvas: cameraCanvasEl, antialias: true });
      cameraRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const rect = cameraCanvasEl.parentElement.getBoundingClientRect();
      cameraRenderer.setSize(rect.width, rect.height);
    }

    // 全景相機 (Global Camera, 固定視角偏置)
    globalViewCamera = new THREE.PerspectiveCamera(50, 1.33, 0.1, 50);
    globalViewCamera.position.set(3.5, 3.2, 3.5);
    globalViewCamera.lookAt(0.8, 0.6, 0);

    // 滑鼠軌跡控制器
    if (THREE && THREE.OrbitControls) {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
    } else if (typeof OrbitControls !== 'undefined') {
      controls = new OrbitControls(camera, renderer.domElement);
    } else {
      console.warn('OrbitControls not available');
      controls = { update: function () { } };
    }
    if (controls.enableDamping !== undefined) controls.enableDamping = true;
    if (controls.target) controls.target.set(0, 1.2, 0);

    // 燈光設置
    scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(5, 8, 4);
    scene.add(dir);
    const rim = new THREE.DirectionalLight(0x4DA3FF, 0.3);
    rim.position.set(-5, 3, -5);
    scene.add(rim);

    // 建立 3D 靜態與動態模型
    buildFloorGrid();
    buildAxesGizmo();
    buildTableAndWorkpiece();
    buildRobotArm();

    // 視窗 Resize 事件重置投影矩陣與寬高
    window.addEventListener("resize", () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);

      if (cameraRenderer && cameraCanvasEl) {
        const r = cameraCanvasEl.parentElement.getBoundingClientRect();
        cameraRenderer.setSize(r.width, r.height);
        if (onHandCamera) { onHandCamera.aspect = r.width / r.height; onHandCamera.updateProjectionMatrix(); }
        if (globalViewCamera) { globalViewCamera.aspect = r.width / r.height; globalViewCamera.updateProjectionMatrix(); }
      }
    });
  }

  function buildFloorGrid() {
    const grid = new THREE.GridHelper(14, 28, 0x2a3140, 0x1a2029);
    scene.add(grid);
  }

  function buildAxesGizmo() {
    const axes = new THREE.AxesHelper(0.6);
    axes.position.set(-3.2, 0.02, 3.2);
    scene.add(axes);
  }

  // 建模：間歇式輸送帶系統
  function buildTableAndWorkpiece() {
    // 1. 輸送帶支撐金屬框架
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 3.4), MAT_TABLE);
    frame.position.set(1.6, 0.5, 0);
    scene.add(frame);

    // 2. 橡膠皮帶表面
    const MAT_BELT = new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.9, metalness: 0.1 });
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.02, 3.4), MAT_BELT);
    belt.position.set(1.6, 0.565, 0);
    scene.add(belt);

    // 3. 兩端傳動滾筒
    const rollerGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.68, 20);
    const roller1 = new THREE.Mesh(rollerGeo, MAT_JOINT);
    roller1.rotation.z = Math.PI / 2;
    roller1.position.set(1.6, 0.5, -1.7);
    scene.add(roller1);

    const roller2 = new THREE.Mesh(rollerGeo, MAT_JOINT);
    roller2.rotation.z = Math.PI / 2;
    roller2.position.set(1.6, 0.5, 1.7);
    scene.add(roller2);

    // 4. 四條防震支撐腿
    const legGeo = new THREE.BoxGeometry(0.08, 0.5, 0.08);
    [[-1.4], [1.4]].forEach(([dz]) => {
      const legL = new THREE.Mesh(legGeo, MAT_BASE);
      legL.position.set(1.3, 0.25, dz);
      scene.add(legL);
      const legR = new THREE.Mesh(legGeo, MAT_BASE);
      legR.position.set(1.9, 0.25, dz);
      scene.add(legR);
    });

    // 5. 工作站掃描中心基準黃線
    const stationLine = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.002, 0.04), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    stationLine.position.set(1.6, 0.576, 0);
    scene.add(stationLine);

    // 6. 加工工件 (Workpiece)
    const part = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.25, 0.35), MAT_PART);
    part.position.set(1.6, 0.69, 0);
    scene.add(part);
    RobotScene._workpiece = part;
  }

  // 建模：6-DOF 機械手臂幾何結構與樹狀 Scene Graph 掛載
  function buildRobotArm() {
    // 機器人底座 (Base)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.35, 32), MAT_BASE);
    base.position.set(0, 0.175, 0);
    scene.add(base);

    // J1 — 繞 Y 軸旋轉 (Base Yaw)
    const j1 = new THREE.Group(); j1.position.set(0, 0.35, 0);
    scene.add(j1);
    const j1Body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.3, 24), MAT_JOINT);
    j1Body.position.y = 0.15; j1.add(j1Body);

    // J2 — 繞 Z 軸旋轉 (Shoulder Pitch)
    const j2 = new THREE.Group(); j2.position.set(0, 0.35, 0);
    j1.add(j2);
    const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.4, 0.32), MAT_ARM);
    upperArm.position.set(0, 0.7, 0); j2.add(upperArm);
    const j2Body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 20), MAT_JOINT);
    j2.add(j2Body);

    // J3 — 繞 Z 軸旋轉 (Elbow Pitch)
    const j3 = new THREE.Group(); j3.position.set(0, 1.4, 0);
    j2.add(j3);
    const foreArm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.1, 0.26), MAT_ARM);
    foreArm.position.set(0, 0.55, 0); j3.add(foreArm);
    const j3Body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 20), MAT_JOINT);
    j3.add(j3Body);

    // J4 — 繞 Y 軸旋轉 (Wrist Roll)
    const j4 = new THREE.Group(); j4.position.set(0, 1, 0);
    j3.add(j4);
    const wristLink = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.3, 20), MAT_JOINT);
    wristLink.rotation.x = Math.PI / 2;
    wristLink.position.y = 0.15; j4.add(wristLink);

    // J5 — 繞 Z 軸旋轉 (Wrist Pitch)
    const j5 = new THREE.Group(); j5.position.set(0, 0.3, 0);
    j4.add(j5);
    const wrist2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.35, 0.2), MAT_ARM);
    wrist2.position.set(0.1, 0.15, 0); j5.add(wrist2);

    // J6 — 繞 Y 軸旋轉 (Tool Roll)
    const j6 = new THREE.Group(); j6.position.set(0.1, 0.35, 0);
    j5.add(j6);
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 20), MAT_JOINT);
    j6.add(flange);

    // 簡易末端夾爪模型
    const gripperBase = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), MAT_BASE);
    gripperBase.position.set(0, 0.09, 0); j6.add(gripperBase);
    const fingerGeo = new THREE.BoxGeometry(0.04, 0.22, 0.06);
    const fingerL = new THREE.Mesh(fingerGeo, MAT_BASE); fingerL.position.set(-0.07, 0.24, 0); j6.add(fingerL);
    const fingerR = new THREE.Mesh(fingerGeo, MAT_BASE); fingerR.position.set(0.07, 0.24, 0); j6.add(fingerR);

    // 🎯 於 J6 工具末端掛載真實 3D On-Hand First-Person Camera (眼在手相機)
    onHandCamera = new THREE.PerspectiveCamera(65, 1.33, 0.05, 50);
    onHandCamera.position.set(0, 0.3, 0);
    // 旋轉配置：朝向 +Y 軸（夾爪指尖），並順時針轉動 90 度以配合視訊流規格
    onHandCamera.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    j6.add(onHandCamera);

    jointGroups = [j1, j2, j3, j4, j5, j6];
  }

  function setTargetAngles(angles) {
    fromAngles = currentAngles.slice();
    toAngles = angles.slice();
    lerpT = 0;
  }

  // 渲染時鐘循環 (每幀執行)
  function updateFrame(dtMs) {
    // 1. 關節角度平滑 Lerp 插值
    if (lerpT < 1) {
      lerpT = Math.min(1, lerpT + dtMs / LERP_DURATION);
      for (let i = 0; i < 6; i++) {
        currentAngles[i] = THREE.MathUtils.lerp(fromAngles[i], toAngles[i], lerpT);
      }
    }
    const [a1, a2, a3, a4, a5, a6] = currentAngles.map(THREE.MathUtils.degToRad);
    if (jointGroups[0]) jointGroups[0].rotation.y = a1;
    if (jointGroups[1]) jointGroups[1].rotation.z = a2;
    if (jointGroups[2]) jointGroups[2].rotation.z = a3;
    if (jointGroups[3]) jointGroups[3].rotation.y = a4;
    if (jointGroups[4]) jointGroups[4].rotation.z = a5;
    if (jointGroups[5]) jointGroups[5].rotation.y = a6;

    // 2. 工件在輸送帶上的位移模擬與可見度控制
    if (RobotScene._workpiece) {
      const state = (typeof ApiClient !== 'undefined') ? ApiClient.getLatestState() : null;
      if (state && state.conveyor) {
        const convState = state.conveyor.state;
        const clock = state.conveyor.stateClock || 0;
        if (convState === "ARRIVING") {
          const progress = Math.min(1, clock / 1500);
          RobotScene._workpiece.position.set(1.6, 0.69, -1.7 + progress * 1.7);
          RobotScene._workpiece.visible = true;
        } else if (convState === "SCANNING") {
          RobotScene._workpiece.position.set(1.6, 0.69, 0.0);
          RobotScene._workpiece.visible = true;
        } else if (convState === "DEPARTING") {
          const progress = Math.min(1, clock / 1500);
          RobotScene._workpiece.position.set(1.6, 0.69, progress * 1.7);
          RobotScene._workpiece.visible = true;
        } else {
          RobotScene._workpiece.visible = false;
        }
      } else {
        RobotScene._workpiece.visible = RobotScene._workpieceVisible !== false;
      }
    }
    controls.update();

    // 3. 渲染主 3D 視窗
    renderer.render(scene, camera);

    // 4. 渲染 Camera 副視窗（切換 FPV 或全景鏡頭）
    if (cameraRenderer && typeof CameraSimulator !== 'undefined') {
      const mode = CameraSimulator.getMode();
      const activeCam = (mode === "global") ? globalViewCamera : onHandCamera;
      if (activeCam) {
        cameraRenderer.render(scene, activeCam);
      }
    }
  }

  return { init, setTargetAngles, updateFrame };
})();


/* =========================================================================
 * 區域 4：UI 配線與遙測同步 (UI WIRING & TELEMETRY UPDATER)
 * -------------------------------------------------------------------------
 * 職責：
 *   - 狀態列 (Status Bar) 連線狀態、工作狀態、FPS 與時間顯示更新。
 *   - 事件日誌 (Event Log) 的追加、過濾器 (State/System/Alarm) 及抽屜滑入滑出動作。
 *   - 數據趨勢儀表板 (Sparklines) 圖表繪製與馬達溫度/電流雙折線 Canvas 渲染。
 * ========================================================================= */

// --- 4.1 即時迷你曲線圖 (Sparklines) 繪製 ---
function sparkline(canvas, values, color, min, max) {
  const ctx = canvas.getContext("2d");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const span = (hi - lo) || 1;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - lo) / span) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = color.replace(")", ",0.12)").replace("rgb", "rgba");
  ctx.fill();
}

// 數據歷史庫 (滾動式滑動窗口)
const history = { speed: [], accel: [], vib: [], temp: [], curr: [] };
const HIST_LEN = 60;
function pushHist(key, v) { const a = history[key]; a.push(v); if (a.length > HIST_LEN) a.shift(); }

// --- 4.2 事件日誌渲染與抽屜開關 ---
const eventListEl = document.getElementById("eventList");
const EVENT_COLORS = { state: getCss("--primary"), system: getCss("--text-dim"), alarm: getCss("--warning") };
function getCss(varName) { return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }

function addEventItem({ kind, title, desc, time }) {
  const item = document.createElement("div");
  item.className = "event-item";
  item.dataset.kind = kind;
  const timeStr = time.toTimeString().slice(0, 8);
  item.innerHTML = `
    <span class="dot" style="background:${EVENT_COLORS[kind] || "#888"}"></span>
    <div>
      <div class="time">${timeStr} &nbsp; <span class="title">${title}</span></div>
      <div class="desc">${desc}</div>
    </div>`;
  eventListEl.prepend(item);
  while (eventListEl.children.length > 40) eventListEl.removeChild(eventListEl.lastChild);
  applyEventFilter();
}

function applyEventFilter() {
  const f = document.getElementById("eventFilter").value;
  [...eventListEl.children].forEach(el => {
    el.style.display = (f === "all" || el.dataset.kind === f) ? "" : "none";
  });
}
document.getElementById("eventFilter").addEventListener("change", applyEventFilter);

// Event Log Panel 抽屜開關監聽
const eventlogPanel = document.getElementById("eventlogPanel");
document.getElementById("eventlogTab").addEventListener("click", () => {
  eventlogPanel.classList.add("open");
});
document.getElementById("eventlogToggle").addEventListener("click", () => {
  eventlogPanel.classList.remove("open");
});

// --- 4.3 即時狀態列 (Status Bar) 數據填充 ---
function updateStatusBar(state) {
  if (!state) {
    document.getElementById("onlineDot").style.background = "var(--warning)";
    document.getElementById("onlineText").textContent = "Disconnected";
    return;
  }
  document.getElementById("onlineDot").style.background = "var(--success)";
  document.getElementById("onlineText").textContent = "Online";
  document.getElementById("robotMode").textContent = state.robot.mode;
  document.getElementById("robotState").textContent = state.robot.state;
  document.getElementById("cycleCount").textContent = state.robot.cycle;
  document.getElementById("latencyVal").textContent = state.system.latencyMs + "ms";
  const t = new Date(state.system.timestamp);
  document.getElementById("clock").textContent = t.toTimeString().slice(0, 8);
}

// --- 4.4 即時趨勢面板 (Trend Panel) 折線圖繪製 ---
function updateTrends(state) {
  const { speed, accel } = state.robot;
  const { vibration, motorTemp, motorCurrent } = state.trend;
  pushHist("speed", speed); pushHist("accel", accel);
  pushHist("vib", vibration); pushHist("temp", motorTemp); pushHist("curr", motorCurrent);

  document.getElementById("speedVal").textContent = speed.toFixed(1);
  document.getElementById("accelVal").textContent = accel.toFixed(1);
  document.getElementById("vibVal").textContent = vibration.toFixed(3);

  sparkline(document.getElementById("chartSpeed"), history.speed, "rgb(77,163,255)", 0, 600);
  sparkline(document.getElementById("chartAccel"), history.accel, "rgb(34,197,94)", 0, 300);
  sparkline(document.getElementById("chartVib"), history.vib, "rgb(245,158,11)", 0, 0.1);

  // 馬達溫度與電流雙曲線混合圖 Canvas 渲染
  const canvas = document.getElementById("chartMotor");
  const ctx = canvas.getContext("2d");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  drawLine(ctx, history.temp, w, h, "rgb(245,158,11)", 0, 60);
  drawLine(ctx, history.curr, w, h, "rgb(34,197,94)", 0, 4);
}

function drawLine(ctx, values, w, h, color, lo, hi) {
  if (values.length < 2) return;
  const span = (hi - lo) || 1;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w, y = h - ((v - lo) / span) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
}


/* =========================================================================
 * 區域 5：相機 HUD 二維畫布儀表 (CAMERA SIMULATOR)
 * -------------------------------------------------------------------------
 * 職責：
 *   - 管理相機選單與視角模式 (Mode Select: Global / On-Hand)。
 *   - 建立疊加在 WebGL 畫布上方的 2D 透明 HUD Overlay。
 *   - 繪製動態第一人稱輔助線（Crosshair）、動態雷射掃描束 (Laser Bar),
 *     錄影狀態燈 (REC Indicator) 與即時影像時戳。
 * ========================================================================= */

const CameraSimulator = (() => {
  let hudCanvas, ctx;
  let cameraMode = "onhand";
  let robotState = null;
  let t = 0;
  let selectEl = null;

  function init() {
    hudCanvas = document.getElementById("cameraHudCanvas");
    if (hudCanvas) {
      ctx = hudCanvas.getContext("2d");
    }
    selectEl = document.getElementById("cameraSelect");
    if (selectEl) {
      cameraMode = selectEl.value || "onhand";
      selectEl.addEventListener("change", (e) => {
        setCameraMode(e.target.value);
      });
    }
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    updateLabel();
  }

  function setCameraMode(mode) {
    cameraMode = mode;
    if (selectEl && selectEl.value !== mode) {
      selectEl.value = mode;
    }
    updateLabel();
  }

  function getMode() { return cameraMode; }

  function updateLabel() {
    // const labelEl = document.getElementById("cameraLabel");
    // if (labelEl) {
    //   labelEl.textContent = cameraMode === "global"
    //     ? "Global Camera（全景工作站視角）"
    //     : "On-Hand Camera（末端第一人稱視角）";
    // }
  }

  function resizeCanvas() {
    if (!hudCanvas || !hudCanvas.parentElement) return;
    const rect = hudCanvas.parentElement.getBoundingClientRect();
    if (hudCanvas.width !== rect.width || hudCanvas.height !== rect.height) {
      hudCanvas.width = rect.width;
      hudCanvas.height = rect.height;
    }
  }

  // HUD 繪製主流程
  function drawFrame(state) {
    robotState = state;
    t += 16;
    if (!hudCanvas || !ctx) return;
    resizeCanvas();
    const w = hudCanvas.width, h = hudCanvas.height;

    // 清除 2D 畫布，使下方 WebGL 3D 畫面透出
    ctx.clearRect(0, 0, w, h);

    if (cameraMode === "global") {
      drawGlobalHud(w, h);
    } else {
      drawOnHandHud(w, h);
    }

    drawOverlay(w, h);
  }

  // 全景 HUD 繪製
  function drawGlobalHud(w, h) {
    const conveyorState = robotState?.conveyor?.state || robotState?.robot?.state || "STOP";
    const stateColor = {
      "ARRIVING": "#ecc94b",
      "SCANNING": "#48bb78",
      "DEPARTING": "#ed8936",
      "WAIT_WORKPIECE": "#a0aec0",
      "WAIT_NEXT": "#a0aec0"
    }[conveyorState] || "#4299e1";

    ctx.fillStyle = stateColor;
    ctx.beginPath(); ctx.arc(w - 18, 30, 5, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#cbd5e0";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText("3D GLOBAL CAM | FSM: " + conveyorState, 10, 18);
  }

  // FPV 第一人稱 HUD 繪製
  function drawOnHandHud(w, h) {
    // const conveyorState = robotState?.conveyor?.state || robotState?.robot?.state || "STOP";
    // const isScanning = conveyorState === "SCANNING";

    // ctx.strokeStyle = isScanning ? "#48bb78" : "rgba(160, 174, 192, 0.65)";
    // ctx.lineWidth = 1.5;

    // // 十字輔助準心
    // const boxSize = 38;
    // ctx.strokeRect(w / 2 - boxSize / 2, h / 2 - boxSize / 2, boxSize, boxSize);

    // const crossSize = 10;
    // ctx.beginPath();
    // ctx.moveTo(w / 2 - crossSize, h / 2); ctx.lineTo(w / 2 + crossSize, h / 2);
    // ctx.moveTo(w / 2, h / 2 - crossSize); ctx.lineTo(w / 2, h / 2 + crossSize);
    // ctx.stroke();

    // // 綠色動態雷射掃描束 (SCANNING)
    // if (isScanning) {
    //   const scanY = h / 2 + Math.sin(t / 180) * 28;
    //   ctx.strokeStyle = "rgba(72, 187, 120, 0.85)";
    //   ctx.lineWidth = 2;
    //   ctx.beginPath(); ctx.moveTo(w / 2 - 45, scanY); ctx.lineTo(w / 2 + 45, scanY); ctx.stroke();
    // }

    // ctx.fillStyle = isScanning ? "#48bb78" : "#e2e8f0";
    // ctx.font = "11px monospace";
    // ctx.textAlign = "left";
    // ctx.fillText("3D ON-HAND FPV (EYE-IN-HAND)", 10, 18);
    // ctx.fillText("STATE: " + conveyorState, 10, 32);

    // if (isScanning) {
    //   ctx.fillStyle = "#48bb78";
    //   ctx.fillText("◉ SCANNING WORKPIECE...", 10, 46);
    // }
  }

  // 通用覆蓋物（REC 紅色呼吸燈、即時時間戳）
  function drawOverlay(w, h) {
    // const recAlpha = 0.5 + Math.sin(t / 300) * 0.4;
    // ctx.fillStyle = `rgba(245, 101, 101, ${recAlpha})`;
    // ctx.beginPath(); ctx.arc(w - 20, 15, 4, 0, Math.PI * 2); ctx.fill();
    // ctx.fillStyle = "#feb2b2";
    // ctx.font = "10px Arial";
    // ctx.textAlign = "right";
    // ctx.fillText("REC", w - 28, 18);

    // const now = new Date();
    // const timeStr = now.toTimeString().slice(0, 8);
    // ctx.fillStyle = "#68d391";
    // ctx.font = "10px monospace";
    // ctx.textAlign = "left";
    // ctx.fillText(timeStr, 10, h - 8);
  }

  return { init, setCameraMode, getMode, drawFrame };
})();


/* =========================================================================
 * 區域 6：生命週期管理與引導啟動 (BOOTSTRAP)
 * -------------------------------------------------------------------------
 * 職責：
 *   - 當 DOMContentLoaded 觸發時執行引導啟動。
 *   - 初始化 3D 渲染主場景與 Camera HUD 二維層。
 *   - 向 ConveyorFSM 與 RobotFSM 訂閱事件以寫入事件日誌 (Event Log)。
 *   - 向 ApiClient 註冊更新回呼以定時刷新 UI、圖表與驅動手臂姿態更新。
 *   - 啟動 requestAnimationFrame 主動畫時脈循環 (animate)。
 * ========================================================================= */

window.addEventListener("DOMContentLoaded", () => {
  const container = document.querySelector("#viewport-panel .panel-body");
  RobotScene.init(container);
  CameraSimulator.init();

  // 訂閱事件推播至 Event Log Drawer
  ConveyorFSM.onEvent(addEventItem);
  RobotFSM.onEvent(addEventItem);

  // 接收 ApiClient 遙測更新推播
  ApiClient.onUpdate((state, err) => {
    if (err || !state) { updateStatusBar(null); return; }
    updateStatusBar(state);
    updateTrends(state);
    RobotScene.setTargetAngles(state.robot.joints);
    CameraSimulator.drawFrame(state);
  });

  // 啟動 API 資料泵
  ApiClient.start();

  // 60FPS 動畫主時脈循環 (Orchestrating Animation Frame Loop)
  let last = performance.now();
  let frames = 0, fpsClock = 0;
  function animate(now) {
    const dt = now - last; last = now;
    frames++; fpsClock += dt;
    if (fpsClock >= 1000) {
      document.getElementById("fpsVal").textContent = frames;
      frames = 0; fpsClock = 0;
    }
    RobotScene.updateFrame(dt);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
});

/*
  GATEBOUND — Firebase Realtime Multiplayer Board Game
  ---------------------------------------------------
  1) Replace the firebaseConfig values below with your Firebase project's Web App config.
  2) Enable Authentication > Sign-in method > Anonymous.
  3) Create a Realtime Database and deploy the rules supplied with this project.
  4) Host these files from GitHub Pages.
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, get, set, update, onValue, onDisconnect, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ===================== FIREBASE CONFIG =====================
// Replace every value with your own Firebase Web App configuration.
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyA4H9N2pG5VsayUwHfy_o58s3KXg3CgORI",
  authDomain: "gateout-5f0c9.firebaseapp.com",
  databaseURL: "https://gateout-5f0c9-default-rtdb.firebaseio.com",
  projectId: "gateout-5f0c9",
  storageBucket: "gateout-5f0c9.firebasestorage.app",
  messagingSenderId: "281924678450",
  appId: "1:281924678450:web:8ee27300fb76a4968d5d2b",
  measurementId: "G-1Q3MC1YJ8R"
};
// ===========================================================

const BOARD_SIZE = 8;
const START_COL = 3; // fourth column is the consistent center column on an 8x8 board
const ROOM_CODE_LENGTH = 6;
const ROOM_STORAGE_KEY = "gateboundRoom";
const ROLE_STORAGE_KEY = "gateboundRole";
const GAME_VERSION = 1;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const $ = (id) => document.getElementById(id);
const screens = {
  home: $("homeScreen"),
  lobby: $("lobbyScreen"),
  game: $("gameScreen"),
  result: $("resultScreen")
};

let currentUser = null;
let roomId = null;
let role = null;
let roomState = null;
let unsubscribeRoom = null;
let currentAction = "move";
let toastTimer = null;
let roomListenerActive = false;

function isFirebaseConfigured() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_") && firebaseConfig.databaseURL && !firebaseConfig.databaseURL.includes("YOUR_PROJECT");
}

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("active"));
  screens[name].classList.add("active");
}

function setLoading(show, text = "Connecting…") {
  $("loadingOverlay").classList.toggle("hidden", !show);
  $("loadingText").textContent = text;
}

function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setHomeMessage(message, type = "") {
  $("homeMessage").textContent = message;
  $("homeMessage").className = `message ${type}`;
}

function setLobbyMessage(message, type = "") {
  $("lobbyMessage").textContent = message;
  $("lobbyMessage").className = `message ${type}`;
}

function setConnection(connected) {
  const badge = $("connectionBadge");
  badge.textContent = connected ? "● Online" : "○ Offline / reconnecting";
  badge.className = `connection-badge ${connected ? "online" : "offline"}`;
}

function sanitizeRoomCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}

function playerName(r) {
  return r === "player1" ? "Player 1" : "Player 2";
}

function getLocalPlayer() {
  return roomState?.players?.[role] || null;
}

function getOpponentRole() {
  return role === "player1" ? "player2" : "player1";
}

function roomRef() {
  return ref(db, `rooms/${roomId}`);
}

function roomField(path) {
  return ref(db, `rooms/${roomId}/${path}`);
}

function initialRoom(hostId) {
  return {
    version: GAME_VERSION,
    hostId,
    status: "waiting",
    currentTurn: "player1",
    winner: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastAction: null,
    players: {
      player1: {
        id: hostId,
        connected: true,
        row: 7,
        col: START_COL,
        joinedAt: serverTimestamp()
      },
      player2: null
    },
    gates: {}
  };
}

async function createRoom() {
  if (!currentUser) return showToast("Still connecting to Firebase.");
  setLoading(true, "Creating room…");
  setHomeMessage("");

  try {
    let created = false;
    let candidate = "";
    for (let i = 0; i < 8 && !created; i++) {
      candidate = generateRoomCode();
      const target = ref(db, `rooms/${candidate}`);
      const tx = await runTransaction(target, (existing) => existing === null ? initialRoom(currentUser.uid) : undefined);
      if (tx.committed) created = true;
    }
    if (!created) throw new Error("Could not create a unique room. Please try again.");
    roomId = candidate;
    role = "player1";
    saveRoomSession();
    await preparePresence();
    listenToRoom();
    showScreen("lobby");
    showToast(`Room ${roomId} created`);
  } catch (error) {
    console.error(error);
    setHomeMessage(error.message || "Could not create room.", "error");
  } finally {
    setLoading(false);
  }
}

async function joinRoom(code) {
  if (!currentUser) return showToast("Still connecting to Firebase.");
  const clean = sanitizeRoomCode(code);
  if (clean.length !== ROOM_CODE_LENGTH) {
    setHomeMessage("Enter the 6-character room code.", "error");
    return;
  }
  setLoading(true, "Joining room…");
  setHomeMessage("");

  try {
    const target = ref(db, `rooms/${clean}`);
    const snapshot = await get(target);
    if (!snapshot.exists()) throw new Error("Room not found.");
    const data = snapshot.val();
    if (data.status === "finished") throw new Error("Game has ended.");
    if (data.players?.player2) throw new Error("Room is full.");
    if (!data.players?.player1?.id) throw new Error("Room is invalid.");

    const joinTx = await runTransaction(ref(db, `rooms/${clean}/players/player2`), (existing) => {
      if (existing !== null) return;
      return {
        id: currentUser.uid,
        connected: true,
        row: 0,
        col: START_COL,
        joinedAt: serverTimestamp()
      };
    });
    if (!joinTx.committed) throw new Error("Room is full.");

    roomId = clean;
    role = "player2";
    saveRoomSession();
    await preparePresence();
    listenToRoom();
    showScreen("lobby");
    showToast(`Joined room ${roomId}`);
  } catch (error) {
    console.error(error);
    setHomeMessage(error.message || "Could not join room.", "error");
  } finally {
    setLoading(false);
  }
}

function saveRoomSession() {
  if (!roomId || !role) return;
  localStorage.setItem(ROOM_STORAGE_KEY, roomId);
  localStorage.setItem(ROLE_STORAGE_KEY, role);
}

function clearRoomSession() {
  localStorage.removeItem(ROOM_STORAGE_KEY);
  localStorage.removeItem(ROLE_STORAGE_KEY);
}

async function restoreSession() {
  const savedRoom = localStorage.getItem(ROOM_STORAGE_KEY);
  const savedRole = localStorage.getItem(ROLE_STORAGE_KEY);
  if (!savedRoom || !savedRole || !currentUser) return false;

  try {
    const snapshot = await get(ref(db, `rooms/${savedRoom}`));
    if (!snapshot.exists()) {
      clearRoomSession();
      return false;
    }
    const data = snapshot.val();
    const savedPlayer = data.players?.[savedRole];
    if (!savedPlayer || savedPlayer.id !== currentUser.uid) {
      clearRoomSession();
      return false;
    }
    if (data.status === "finished") {
      clearRoomSession();
      return false;
    }
    roomId = savedRoom;
    role = savedRole;
    await preparePresence();
    listenToRoom();
    showScreen(data.status === "playing" ? "game" : "lobby");
    showToast("Room restored");
    return true;
  } catch (error) {
    console.warn("Session restore failed", error);
    return false;
  }
}

async function preparePresence() {
  if (!roomId || !role || !currentUser) return;
  const connectedRef = roomField(`players/${role}/connected`);
  await onDisconnect(connectedRef).set(false);
  await set(connectedRef, true);
  setConnection(true);
}

function listenToRoom() {
  if (unsubscribeRoom) unsubscribeRoom();
  roomListenerActive = true;
  unsubscribeRoom = onValue(roomRef(), (snapshot) => {
    if (!snapshot.exists()) {
      clearRoomSession();
      roomId = null;
      role = null;
      roomState = null;
      showScreen("home");
      setHomeMessage("The room no longer exists.", "error");
      return;
    }
    roomState = snapshot.val();
    renderState();
  }, (error) => {
    console.error(error);
    setConnection(false);
    if (roomListenerActive) showToast("Connection lost. Reconnecting…");
  });
}

function renderState() {
  if (!roomState || !role) return;
  setConnection(navigator.onLine);
  updateLobby();
  updateGameHeader();

  if (roomState.status === "waiting") {
    showScreen("lobby");
  } else if (roomState.status === "playing") {
    showScreen("game");
    renderBoard();
  } else if (roomState.status === "finished") {
    renderResult();
    showScreen("result");
  }
}

function updateLobby() {
  $("lobbyRoomCode").textContent = roomId || "------";
  $("roomLinkInput").value = roomId ? `${location.origin}${location.pathname}?room=${roomId}` : "";
  const p1 = roomState.players?.player1;
  const p2 = roomState.players?.player2;
  $("p1LobbyStatus").textContent = p1?.connected ? "Connected" : "Disconnected";
  $("p2LobbyStatus").textContent = p2 ? (p2.connected ? "Connected" : "Disconnected") : "Waiting for player…";
  $("p1LobbyPill").textContent = role === "player1" ? "YOU" : "HOST";
  $("p2LobbyPill").textContent = role === "player2" ? "YOU" : (p2 ? "READY" : "WAITING");
  $("p1LobbyPill").classList.toggle("muted", role !== "player1");
  $("p2LobbyPill").classList.toggle("muted", role !== "player2");
  $("startGameBtn").disabled = !(role === "player1" && p1?.connected && p2?.connected && roomState.status === "waiting");

  if (role === "player1") {
    setLobbyMessage(p2?.connected ? "Player 2 has connected. You can start the game." : "Waiting for Player 2…", p2?.connected ? "success" : "");
  } else {
    setLobbyMessage(p2?.connected ? "You are connected. Waiting for Player 1 to start." : "Waiting…", "");
  }
}

function updateGameHeader() {
  const p1 = roomState.players?.player1;
  const p2 = roomState.players?.player2;
  $("gameP1Status").textContent = p1?.connected ? "Connected" : "Disconnected";
  $("gameP2Status").textContent = p2?.connected ? "Connected" : "Disconnected";
  $("roomLabel").textContent = `Room ${roomId || "------"}`;
  const turn = roomState.currentTurn;
  const mine = turn === role && roomState.status === "playing";
  $("turnLabel").textContent = mine ? "YOUR TURN" : `${playerName(turn)}'S TURN`;
  $("turnStateText").textContent = mine ? "Your turn" : `${playerName(turn)}'s turn`;
  $("yourTurnCard").classList.toggle("not-your-turn", !mine);
  const canAct = mine && roomState.status === "playing" && !!getLocalPlayer()?.connected;
  $("moveModeBtn").disabled = !canAct;
  $("gateModeBtn").disabled = !canAct;
  $("moveModeBtn").classList.toggle("active", currentAction === "move");
  $("gateModeBtn").classList.toggle("active", currentAction === "gate");

  if (p1 && p2) {
    const opponent = getOpponentRole();
    if (!roomState.players[opponent]?.connected && mine) {
      $("boardNote").textContent = "Opponent disconnected — the room is preserved while they reconnect.";
    } else {
      $("boardNote").textContent = mine ? "Choose one action. Your turn ends immediately after it." : "Waiting for the opponent’s action.";
    }
  }
}

function gateKey(r1, c1, r2, c2) {
  if (r1 > r2 || (r1 === r2 && c1 > c2)) return gateKey(r2, c2, r1, c1);
  return `${r1},${c1}|${r2},${c2}`;
}

function gateBetween(r1, c1, r2, c2) {
  return !!roomState?.gates?.[gateKey(r1, c1, r2, c2)];
}

function inBounds(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

function isOccupied(r, c, movingRole = null) {
  const p1 = roomState.players?.player1;
  const p2 = roomState.players?.player2;
  return (movingRole !== "player1" && p1?.row === r && p1?.col === c) || (movingRole !== "player2" && p2?.row === r && p2?.col === c);
}

function legalMove(r, c, targetR, targetC, movingRole = role) {
  if (!inBounds(targetR, targetC)) return false;
  if (Math.abs(targetR - r) + Math.abs(targetC - c) !== 1) return false;
  if (gateBetween(r, c, targetR, targetC)) return false;
  if (isOccupied(targetR, targetC, movingRole)) return false;
  return true;
}

function getLegalMoves(r, c, movingRole = role) {
  const candidates = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
  return candidates.filter(([nr, nc]) => legalMove(r, c, nr, nc, movingRole));
}

function gateIsValidForCurrentBoard(r1, c1, r2, c2) {
  if (!inBounds(r1, c1) || !inBounds(r2, c2)) return false;
  if (Math.abs(r1 - r2) + Math.abs(c1 - c2) !== 1) return false;
  if (gateBetween(r1, c1, r2, c2)) return false;
  // Never place a gate on a crossing that currently has a player in either endpoint.
  if (isOccupied(r1, c1) || isOccupied(r2, c2)) return false;
  // Do not allow a gate that removes every immediate escape from either player.
  for (const r of ["player1", "player2"]) {
    const p = roomState.players?.[r];
    if (!p) continue;
    const moves = getLegalMoves(p.row, p.col, r);
    if (moves.length === 0) return false;
  }
  // Do not allow a gate that makes either player unable to reach the target side.
  const candidate = gateKey(r1, c1, r2, c2);
  return bothPlayersHavePathWithExtraGate(candidate);
}

function bothPlayersHavePathWithExtraGate(extraGateKey) {
  const canReach = (start, targetRow) => {
    const queue = [[start.row, start.col]];
    const seen = new Set([`${start.row},${start.col}`]);
    while (queue.length) {
      const [r, c] = queue.shift();
      if (r === targetRow) return true;
      for (const [nr, nc] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]) {
        if (!inBounds(nr,nc)) continue;
        const key = gateKey(r,c,nr,nc);
        const blocked = key === extraGateKey || !!roomState.gates?.[key];
        if (blocked) continue;
        const k = `${nr},${nc}`;
        if (!seen.has(k)) { seen.add(k); queue.push([nr,nc]); }
      }
    }
    return false;
  };
  const p1 = roomState.players?.player1;
  const p2 = roomState.players?.player2;
  return !!p1 && !!p2 && canReach(p1, 0) && canReach(p2, BOARD_SIZE - 1);
}

function enumerateGateCandidates() {
  const result = [];
  // Horizontal boundary: between rows r and r+1, same column c.
  for (let r = 0; r < BOARD_SIZE - 1; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (gateIsValidForCurrentBoard(r, c, r + 1, c)) result.push({ r1:r, c1:c, r2:r+1, c2:c, orientation:"horizontal" });
    }
  }
  // Vertical boundary: between columns c and c+1, same row r.
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE - 1; c++) {
      if (gateIsValidForCurrentBoard(r, c, r, c + 1)) result.push({ r1:r, c1:c, r2:r, c2:c+1, orientation:"vertical" });
    }
  }
  return result;
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  if (!roomState?.players?.player1 || !roomState?.players?.player2) return;

  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.setAttribute("aria-label", `Row ${r + 1}, column ${c + 1}`);
      const p1 = roomState.players.player1;
      const p2 = roomState.players.player2;
      if (p1.row === r && p1.col === c) {
        const piece = document.createElement("span");
        piece.className = `piece p1 ${role === "player1" ? "you-piece" : ""}`;
        cell.appendChild(piece);
      }
      if (p2.row === r && p2.col === c) {
        const piece = document.createElement("span");
        piece.className = `piece p2 ${role === "player2" ? "you-piece" : ""}`;
        cell.appendChild(piece);
      }
      const mine = roomState.currentTurn === role && roomState.status === "playing" && getLocalPlayer()?.connected;
      if (mine && currentAction === "move") {
        const p = getLocalPlayer();
        if (p && legalMove(p.row, p.col, r, c, role)) {
          cell.classList.add("legal-move");
          cell.addEventListener("click", () => submitMove(r, c));
        }
      }
      board.appendChild(cell);
    }
  }

  renderGates(board);
}

function renderGates(board) {
  const gates = roomState.gates || {};
  for (const key of Object.keys(gates)) {
    const [a,b] = key.split("|");
    const [r1,c1] = a.split(",").map(Number);
    const [r2,c2] = b.split(",").map(Number);
    const gate = document.createElement("span");
    const horizontal = r1 !== r2;
    gate.className = `gate ${horizontal ? "horizontal" : "vertical"}`;
    if (horizontal) {
      gate.style.left = `${((c1 + .5) / BOARD_SIZE) * 100}%`;
      gate.style.top = `${((r1 + 1) / BOARD_SIZE) * 100}%`;
    } else {
      gate.style.left = `${((c1 + 1) / BOARD_SIZE) * 100}%`;
      gate.style.top = `${((r1 + .5) / BOARD_SIZE) * 100}%`;
    }
    board.appendChild(gate);
  }

  if (roomState.currentTurn !== role || roomState.status !== "playing" || currentAction !== "gate" || !getLocalPlayer()?.connected) return;
  for (const g of enumerateGateCandidates()) {
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = `gate-hit valid ${g.orientation}`;
    hit.setAttribute("aria-label", "Place gate here");
    if (g.orientation === "horizontal") {
      hit.style.left = `${((g.c1 + .5) / BOARD_SIZE) * 100}%`;
      hit.style.top = `${((g.r1 + 1) / BOARD_SIZE) * 100}%`;
    } else {
      hit.style.left = `${((g.c1 + 1) / BOARD_SIZE) * 100}%`;
      hit.style.top = `${((g.r1 + .5) / BOARD_SIZE) * 100}%`;
    }
    hit.addEventListener("click", () => submitGate(g));
    board.appendChild(hit);
  }
}

async function submitMove(targetRow, targetCol) {
  if (!roomState || roomState.status !== "playing" || roomState.currentTurn !== role) return;
  const p = getLocalPlayer();
  if (!p || !p.connected || !legalMove(p.row, p.col, targetRow, targetCol, role)) {
    showToast("That move is not legal.");
    return;
  }
  const opponentTargetRow = role === "player1" ? 0 : BOARD_SIZE - 1;
  const wins = targetRow === opponentTargetRow;
  const updates = {
    [`players/${role}/row`]: targetRow,
    [`players/${role}/col`]: targetCol,
    currentTurn: wins ? role : getOpponentRole(),
    status: wins ? "finished" : "playing",
    winner: wins ? role : null,
    updatedAt: serverTimestamp(),
    lastAction: { id: `${Date.now()}_${currentUser.uid}`, type: wins ? "move" : "move", actor: role, from: { row: p.row, col: p.col }, to: { row: targetRow, col: targetCol }, gateKey: null }
  };
  await performAtomicAction(updates, wins ? "win" : "move");
}

async function submitGate(g) {
  if (!roomState || roomState.status !== "playing" || roomState.currentTurn !== role) return;
  if (!gateIsValidForCurrentBoard(g.r1, g.c1, g.r2, g.c2)) {
    showToast("That gate position is not legal.");
    renderBoard();
    return;
  }
  const key = gateKey(g.r1, g.c1, g.r2, g.c2);
  const updates = {
    [`gates/${key}`]: { by: role, at: serverTimestamp() },
    currentTurn: getOpponentRole(),
    updatedAt: serverTimestamp(),
    lastAction: { id: `${Date.now()}_${currentUser.uid}`, type: "gate", actor: role, from: null, to: null, gateKey: key }
  };
  await performAtomicAction(updates, "gate");
}

async function performAtomicAction(changes, actionType) {
  if (!roomId || !currentUser || !roomState) return;
  try {
    const expectedTurn = role;
    const expectedStatus = roomState.status;
    const expectedActionId = roomState.lastAction?.id || null;
    const tx = await runTransaction(roomRef(), (current) => {
      if (!current) return;
      if (current.status !== expectedStatus || current.status !== "playing") return;
      if (current.currentTurn !== expectedTurn) return;
      if ((current.lastAction?.id || null) !== expectedActionId) return;
      const next = structuredClone(current);
      for (const [path, value] of Object.entries(changes)) {
        setNested(next, path, value);
      }
      return next;
    });
    if (!tx.committed) {
      showToast("Action rejected. The board changed; try again.");
      return;
    }
    currentAction = "move";
    if (actionType === "win") showToast(`${playerName(role)} wins!`);
  } catch (error) {
    console.error(error);
    showToast("Could not sync that action. Please try again.");
  }
}

function setNested(obj, path, value) {
  const parts = path.split("/");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor[parts[i]]) cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

async function startGame() {
  if (!roomState || role !== "player1" || !roomState.players?.player2?.connected) return;
  try {
    const tx = await runTransaction(roomRef(), (current) => {
      if (!current || current.status !== "waiting") return;
      if (current.hostId !== currentUser.uid) return;
      if (!current.players?.player1?.connected || !current.players?.player2?.connected) return;
      current.status = "playing";
      current.currentTurn = "player1";
      current.winner = null;
      current.lastAction = { id: `start_${Date.now()}_${currentUser.uid}`, type: "start", actor: role, from: null, to: null, gateKey: null };
      return current;
    });
    if (!tx.committed) showToast("Both players must be connected before starting.");
    else showToast("Game started");
  } catch (error) {
    console.error(error);
    showToast("Could not start the game.");
  }
}

function renderResult() {
  const winner = roomState?.winner;
  const loser = winner === "player1" ? "player2" : "player1";
  $("resultTitle").textContent = winner ? `${playerName(winner).toUpperCase()} WINS` : "GAME OVER";
  $("resultText").textContent = winner ? `${playerName(winner)} reached the opponent’s starting side. ${playerName(loser)} is the other player.` : "The game has ended.";
}

async function playAgain() {
  if (!roomState || role !== "player1") {
    showToast("Only Player 1 can restart this room.");
    return;
  }
  try {
    const tx = await runTransaction(roomRef(), (current) => {
      if (!current || current.hostId !== currentUser.uid || current.status !== "finished") return;
      if (!current.players?.player1 || !current.players?.player2) return;
      current.status = "playing";
      current.currentTurn = "player1";
      current.winner = null;
      current.gates = {};
      current.players.player1.row = 7;
      current.players.player1.col = START_COL;
      current.players.player2.row = 0;
      current.players.player2.col = START_COL;
      current.lastAction = { id: `restart_${Date.now()}_${currentUser.uid}`, type: "restart", actor: role, from: null, to: null, gateKey: null };
      current.updatedAt = serverTimestamp();
      return current;
    });
    if (!tx.committed) showToast("Could not restart this room.");
    else showToast("New game started");
  } catch (error) {
    console.error(error);
    showToast("Could not restart the game.");
  }
}

async function leaveRoom() {
  if (!roomId || !role) return;
  try {
    await set(roomField(`players/${role}/connected`), false);
  } catch (error) {
    console.warn(error);
  }
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = null;
  roomListenerActive = false;
  clearRoomSession();
  roomId = null;
  role = null;
  roomState = null;
  currentAction = "move";
  showScreen("home");
  setHomeMessage("");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast("Copied");
  }
}

async function shareRoom() {
  const link = `${location.origin}${location.pathname}?room=${roomId}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Join my Gatebound game", text: `Join room ${roomId}`, url: link }); } catch (_) {}
  } else {
    await copyText(link);
  }
}

function setAction(action) {
  if (!roomState || roomState.currentTurn !== role || roomState.status !== "playing") return;
  currentAction = action;
  $("moveModeBtn").classList.toggle("active", action === "move");
  $("gateModeBtn").classList.toggle("active", action === "gate");
  renderBoard();
}

function bindUI() {
  $("createRoomBtn").addEventListener("click", createRoom);
  $("showJoinBtn").addEventListener("click", () => {
    $("joinPanel").classList.remove("hidden");
    $("roomCodeInput").focus();
  });
  $("cancelJoinBtn").addEventListener("click", () => {
    $("joinPanel").classList.add("hidden");
    setHomeMessage("");
  });
  $("joinRoomBtn").addEventListener("click", () => joinRoom($("roomCodeInput").value));
  $("roomCodeInput").addEventListener("input", (e) => e.target.value = sanitizeRoomCode(e.target.value));
  $("roomCodeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(e.target.value); });
  $("startGameBtn").addEventListener("click", startGame);
  $("copyRoomBtn").addEventListener("click", () => copyText(roomId));
  $("shareRoomBtn").addEventListener("click", shareRoom);
  $("leaveRoomBtn").addEventListener("click", leaveRoom);
  $("moveModeBtn").addEventListener("click", () => setAction("move"));
  $("gateModeBtn").addEventListener("click", () => setAction("gate"));
  $("copyGameRoomBtn").addEventListener("click", () => copyText(roomId));
  $("quitGameBtn").addEventListener("click", leaveRoom);
  $("playAgainBtn").addEventListener("click", playAgain);
  $("resultHomeBtn").addEventListener("click", leaveRoom);
  window.addEventListener("online", () => { setConnection(true); if (roomId && role) preparePresence().catch(console.warn); });
  window.addEventListener("offline", () => setConnection(false));
}

async function boot() {
  bindUI();
  const params = new URLSearchParams(location.search);
  const urlRoom = sanitizeRoomCode(params.get("room") || "");
  if (urlRoom) {
    $("joinPanel").classList.remove("hidden");
    $("roomCodeInput").value = urlRoom;
  }

  if (!isFirebaseConfigured()) {
    setConnection(false);
    setHomeMessage("Add your Firebase Web App configuration in game.js before deploying.", "error");
    return;
  }

  setLoading(true, "Signing in anonymously…");
  try {
    await signInAnonymously(auth);
    onAuthStateChanged(auth, async (user) => {
      if (!user) return;
      currentUser = user;
      setConnection(navigator.onLine);
      setLoading(false);
      const restored = await restoreSession();
      if (!restored && urlRoom) setTimeout(() => $("roomCodeInput").focus(), 100);
    });
  } catch (error) {
    console.error(error);
    setLoading(false);
    setConnection(false);
    setHomeMessage("Firebase sign-in failed. Check Anonymous Authentication and your configuration.", "error");
  }
}

boot();


const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { randomInt } = require("node:crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const MAX_PLAYERS = 4;
const ROOM_CODE_LENGTH = 4;
const MISMATCH_DELAY = 1000;

app.use(express.static("public"));

/*
 * rooms:
 * Map<roomCode, {
 *   code, hostId, players, board, flipped, matched,
 *   currentPlayerIndex, status, resolving, turnToken
 * }>
 *
 * Each player:
 * { id, name, score }
 */

const rooms = new Map();
const SYMBOLS = ["🍎", "🍋", "🍇", "🍒", "⭐", "🌙", "🎈", "💎"];
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRoomCode() {
  let code;

  do {
    code = Array.from(
      { length: ROOM_CODE_LENGTH },
      () => ROOM_CHARS[randomInt(ROOM_CHARS.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function makeBoard() {
  return shuffle(
    SYMBOLS.flatMap((symbol, pairId) => [
      { id: pairId * 2, value: symbol },
      { id: pairId * 2 + 1, value: symbol }
    ])
  );
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : undefined;
}

function activePlayer(room) {
  return room.players[room.currentPlayerIndex];
}

function publicState(room) {
  const current = activePlayer(room);

  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score
    })),
    currentPlayerId: current?.id ?? null,
    flipped: [...room.flipped],
    matched: [...room.matched],
    board:
      room.status === "playing" || room.status === "over"
        ? room.board.map((tile) => ({
            id: tile.id,
            value:
              room.matched.includes(tile.id) ||
              room.flipped.includes(tile.id)
                ? tile.value
                : null,
            matched: room.matched.includes(tile.id)
          }))
        : [],
    resolving: room.resolving,
    winnerIds:
      room.status === "over"
        ? getWinnerIds(room)
        : []
  };
}

function getWinnerIds(room) {
  const highest = Math.max(
    ...room.players.map((player) => player.score)
  );

  return room.players
    .filter((player) => player.score === highest)
    .map((player) => player.id);
}

function emitState(room) {
  io.to(room.code).emit("state", publicState(room));
}

function emitNotice(room, message) {
  io.to(room.code).emit("notice", message);
}

function emitError(socket, message) {
  socket.emit("errorMessage", message);
}

function findPlayer(room, socketId) {
  return room.players.find((player) => player.id === socketId);
}

function detachSocket(socket, room) {
  socket.leave(room.code);
  delete socket.data.roomCode;
}

function removeRoomIfEmpty(room) {
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return true;
  }

  return false;
}

function advanceTurn(room) {
  if (room.players.length === 0) return;

  room.currentPlayerIndex =
    (room.currentPlayerIndex + 1) % room.players.length;
  room.turnToken++;
}

function finishGame(room) {
  room.status = "over";
  room.resolving = false;
  room.turnToken++;

  const winners = room.players.filter(
    (player) => player.score === Math.max(
      ...room.players.map((p) => p.score)
    )
  );

  const scores = room.players
    .map((player) => `${player.name}: ${player.score}`)
    .join(" · ");

  const message =
    winners.length > 1
      ? `It's a tie between ${winners.map((p) => p.name).join(", ")}!`
      : `${winners[0].name} wins!`;

  emitState(room);
  emitNotice(room, `${message} Final scores — ${scores}`);
}

function leaveCurrentRoom(socket, announce = true) {
  const room = getRoom(socket);
  if (!room) return;

  const oldIndex = room.players.findIndex(
    (player) => player.id === socket.id
  );

  if (oldIndex === -1) {
    detachSocket(socket, room);
    return;
  }

  const wasActive =
    room.status === "playing" &&
    oldIndex === room.currentPlayerIndex;

  const oldName = room.players[oldIndex].name;

  room.players.splice(oldIndex, 1);
  detachSocket(socket, room);

  if (removeRoomIfEmpty(room)) return;

  // Keep the current index aligned with the remaining player order.
  if (oldIndex < room.currentPlayerIndex) {
    room.currentPlayerIndex--;
  }

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
    emitNotice(room, `${room.players[0].name} is now the host.`);
  }

  if (room.status === "playing") {
    // A departing player may have had a tile face up.
    room.flipped = [];
    room.resolving = false;
    room.turnToken++;

    if (wasActive || oldIndex < room.currentPlayerIndex) {
      room.currentPlayerIndex =
        Math.min(room.currentPlayerIndex, room.players.length - 1);
      advanceTurn(room);
    } else {
      room.currentPlayerIndex =
        Math.min(room.currentPlayerIndex, room.players.length - 1);
    }

    if (room.players.length === 1) {
      room.status = "waiting";
      room.board = [];
      room.matched = [];
      room.flipped = [];
      room.players[0].score = 0;
      room.currentPlayerIndex = 0;
      room.resolving = false;
      room.turnToken++;
      emitNotice(room, "Waiting for another player to join.");
    }
  }

  if (announce) {
    emitNotice(room, `${oldName} left the room.`);
  }

  emitState(room);
}

io.on("connection", (socket) => {
  socket.emit("connected", { id: socket.id });

  socket.on("createRoom", ({ name } = {}) => {
    if (getRoom(socket)) {
      emitError(socket, "Leave your current room first.");
      return;
    }

    const cleanName =
      typeof name === "string" ? name.trim().slice(0, 20) : "";

    if (!cleanName) {
      emitError(socket, "Please enter your name.");
      return;
    }

    const code = makeRoomCode();

    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: cleanName, score: 0 }],
      board: [],
      flipped: [],
      matched: [],
      currentPlayerIndex: 0,
      status: "waiting",
      resolving: false,
      turnToken: 0
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);

    emitState(room);
    emitNotice(room, `Room ${code} created. Invite your friends!`);
  });

  socket.on("joinRoom", ({ name, code } = {}) => {
    if (getRoom(socket)) {
      emitError(socket, "Leave your current room first.");
      return;
    }

    const cleanName =
      typeof name === "string" ? name.trim().slice(0, 20) : "";
    const cleanCode =
      typeof code === "string" ? code.trim().toUpperCase() : "";

    if (!cleanName) {
      emitError(socket, "Please enter your name.");
      return;
    }

    if (!/^[A-Z0-9]{4}$/.test(cleanCode)) {
      emitError(socket, "Enter a valid four-character room code.");
      return;
    }

    const room = rooms.get(cleanCode);

    if (!room) {
      emitError(socket, "Room not found. Check the room code.");
      return;
    }

    if (room.status !== "waiting") {
      emitError(socket, "This game has already started.");
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      emitError(socket, "This room is full (maximum 4 players).");
      return;
    }

    if (
      room.players.some(
        (player) => player.name.toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      emitError(socket, "That name is already in use in this room.");
      return;
    }

    room.players.push({ id: socket.id, name: cleanName, score: 0 });
    socket.data.roomCode = room.code;
    socket.join(room.code);

    emitNotice(room, `${cleanName} joined the room.`);
    emitState(room);
  });

  socket.on("startGame", () => {
    const room = getRoom(socket);
    if (!room) {
      emitError(socket, "Join a room first.");
      return;
    }

    if (socket.id !== room.hostId) {
      emitError(socket, "Only the host can start the game.");
      return;
    }

    if (room.status !== "waiting") {
      emitError(socket, "The game is not waiting to start.");
      return;
    }

    if (room.players.length < 2) {
      emitError(socket, "At least two players are needed.");
      return;
    }

    room.board = makeBoard();
    room.flipped = [];
    room.matched = [];
    room.currentPlayerIndex = 0;
    room.resolving = false;
    room.turnToken++;

    for (const player of room.players) {
      player.score = 0;
    }

    room.status = "playing";
    emitNotice(room, "Game started! Find all eight pairs.");
    emitState(room);
  });

  socket.on("flipTile", ({ tileId } = {}) => {
    const room = getRoom(socket);
    if (!room || room.status !== "playing") return;

    if (room.resolving) {
      emitError(socket, "Wait for the current pair to resolve.");
      return;
    }

    if (activePlayer(room)?.id !== socket.id) {
      emitError(socket, "It's not your turn.");
      return;
    }

    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= 16) {
      emitError(socket, "Invalid tile.");
      return;
    }

    if (room.matched.includes(tileId)) {
      emitError(socket, "That tile is already matched.");
      return;
    }

    if (room.flipped.includes(tileId)) {
      emitError(socket, "That tile is already face up.");
      return;
    }

    room.flipped.push(tileId);
    emitState(room);

    if (room.flipped.length !== 2) return;

    const [firstId, secondId] = room.flipped;
    const first = room.board.find((tile) => tile.id === firstId);
    const second = room.board.find((tile) => tile.id === secondId);

    if (first.value === second.value) {
      room.matched.push(firstId, secondId);

      const player = activePlayer(room);
      player.score++;

      room.flipped = [];

      if (room.matched.length === 16) {
        finishGame(room);
      } else {
        emitNotice(
          room,
          `${player.name} found a match and earns another turn!`
        );
        emitState(room);
      }
    } else {
      room.resolving = true;
      const token = ++room.turnToken;
      const roomCode = room.code;

      emitNotice(room, "No match. Next turn in one second.");
      emitState(room);

      setTimeout(() => {
        const currentRoom = rooms.get(roomCode);

        // Ignore stale timers after a player leaves or the game changes.
        if (
          !currentRoom ||
          currentRoom.status !== "playing" ||
          currentRoom.turnToken !== token ||
          !currentRoom.resolving
        ) {
          return;
        }

        currentRoom.flipped = [];
        currentRoom.resolving = false;
        advanceTurn(currentRoom);

        emitNotice(
          currentRoom,
          `${activePlayer(currentRoom).name}'s turn.`
        );
        emitState(currentRoom);
      }, MISMATCH_DELAY);
    }
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Concentration game running at http://localhost:${PORT}`);
});

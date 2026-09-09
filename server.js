const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname + '/public'));

let rooms = {};

io.on('connection', (socket) => {
    // 1. Tham gia phòng
    socket.on('joinRoom', ({ roomId, username }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                boType: 3,           // Mặc định BO3
                gridSize: 4,         // Mặc định 4x4 (16 mảnh)
                showHint: true,      // Mặc định Bật ảnh gợi ý
                currentRound: 1,
                uploadedImages: {},
                scores: {},
                isRoundActive: false
            };
        }

        const room = rooms[roomId];
        
        if (room.players.length < 2) {
            room.players.push({ 
                id: socket.id, 
                username, 
                isHost: room.players.length === 0,
                avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}` // Avatar tự động
            });
            room.scores[socket.id] = 0;
        }

        // Gửi danh sách người chơi và cấu hình phòng
        io.to(roomId).emit('updateRoomState', {
            players: room.players,
            boType: room.boType,
            gridSize: room.gridSize,
            showHint: room.showHint
        });
    });

    // 2. Chủ phòng thay đổi cài đặt (BO, Số mảnh, Ảnh gợi ý)
    socket.on('updateRoomSettings', ({ roomId, boType, gridSize, showHint }) => {
        const room = rooms[roomId];
        if (room && room.players[0]?.id === socket.id) {
            room.boType = parseInt(boType);
            room.gridSize = parseInt(gridSize);
            room.showHint = !!showHint;

            io.to(roomId).emit('roomSettingsUpdated', {
                boType: room.boType,
                gridSize: room.gridSize,
                showHint: room.showHint
            });
        }
    });

    // 3. Xử lý tải ảnh lên từng round
    socket.on('submitImage', ({ roomId, imageSrc }) => {
        const room = rooms[roomId];
        if (!room) return;

        const round = room.currentRound;
        const pickerIndex = getPickerForRound(round, room.boType);

        if (pickerIndex === 0 || pickerIndex === 1) {
            startRoundGame(roomId, imageSrc);
        } else if (pickerIndex === 'RANDOM') {
            room.uploadedImages[socket.id] = imageSrc;

            if (Object.keys(room.uploadedImages).length === 2) {
                const imgArray = Object.values(room.uploadedImages);
                const selectedImg = imgArray[Math.floor(Math.random() * imgArray.length)];
                room.uploadedImages = {};
                startRoundGame(roomId, selectedImg);
            } else {
                socket.emit('waitingForOtherImage');
            }
        }
    });

    // 4. Đồng bộ tiến độ
    socket.on('updateProgress', ({ roomId, placedPieces, totalPieces }) => {
        if (rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            if (player) {
                const progress = Math.round((placedPieces / totalPieces) * 100);
                io.to(roomId).emit('playerProgressUpdate', {
                    socketId: socket.id,
                    username: player.username,
                    progress
                });
            }
        }
    });

    // 5. Thắng Round / Thắng Match
    socket.on('playerWin', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room || !room.isRoundActive) return;

        room.isRoundActive = false;
        room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

        const maxWins = Math.ceil(room.boType / 2);
        const p1Score = room.scores[room.players[0].id] || 0;
        const p2Score = room.scores[room.players[1]?.id] || 0;

        if (p1Score >= maxWins || p2Score >= maxWins) {
            io.to(roomId).emit('matchOver', {
                winner: username,
                scores: room.scores,
                players: room.players
            });
            delete rooms[roomId];
        } else {
            room.currentRound++;
            io.to(roomId).emit('roundOver', {
                roundWinner: username,
                nextRound: room.currentRound,
                scores: room.scores,
                players: room.players,
                nextPickerIndex: getPickerForRound(room.currentRound, room.boType)
            });
        }
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            io.to(roomId).emit('updateRoomState', {
                players: rooms[roomId].players,
                boType: rooms[roomId].boType,
                gridSize: rooms[roomId].gridSize,
                showHint: rooms[roomId].showHint
            });
            if (rooms[roomId].players.length === 0) delete rooms[roomId];
        }
    });
});

function getPickerForRound(round, boType) {
    if (boType === 1) return 'RANDOM';
    if (boType === 3) return round === 1 ? 0 : (round === 2 ? 1 : 'RANDOM');
    if (boType === 5) return round % 2 !== 0 ? (round === 5 ? 'RANDOM' : 0) : 1;
}

function startRoundGame(roomId, imageSrc) {
    const room = rooms[roomId];
    room.isRoundActive = true;
    io.to(roomId).emit('gameStarted', {
        imageSrc,
        gridSize: room.gridSize,
        showHint: room.showHint,
        currentRound: room.currentRound,
        scores: room.scores,
        players: room.players
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname + '/public'));

let rooms = {};

io.on('connection', (socket) => {
    // 1. Vào phòng
    socket.on('joinRoom', ({ roomId, username }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                boType: 3,          // Mặc định BO3
                currentRound: 1,    // Round hiện tại
                uploadedImages: {}, // Lưu ảnh nhận được ở round quyết định
                scores: {},         // Tỉ số thắng
                isRoundActive: false
            };
        }

        const room = rooms[roomId];
        
        // Thêm người chơi mới
        if (room.players.length < 2) {
            room.players.push({ id: socket.id, username, isHost: room.players.length === 0 });
            room.scores[socket.id] = 0;
        }

        io.to(roomId).emit('updatePlayers', room.players);

        if (room.players.length === 2) {
            io.to(roomId).emit('roomReady', {
                msg: 'Phòng đã đủ 2 người!',
                players: room.players,
                boType: room.boType
            });
        }
    });

    // 2. Chủ phòng cài đặt BO
    socket.on('setBoType', ({ roomId, boType }) => {
        if (rooms[roomId]) {
            rooms[roomId].boType = parseInt(boType);
            io.to(roomId).emit('boTypeUpdated', rooms[roomId].boType);
        }
    });

    // 3. Xử lý logic Picker từng ván
    socket.on('submitImage', ({ roomId, imageSrc }) => {
        const room = rooms[roomId];
        if (!room) return;

        const round = room.currentRound;
        const pickerIndex = getPickerForRound(round, room.boType);

        // Trường hợp Pick cố định (P1 hoặc P2)
        if (pickerIndex === 0 || pickerIndex === 1) {
            startRoundGame(roomId, imageSrc);
        } 
        // Trường hợp Random (Trận quyết định / tie-breaker)
        else if (pickerIndex === 'RANDOM') {
            room.uploadedImages[socket.id] = imageSrc;

            // Nếu cả 2 đã upload ảnh xong
            if (Object.keys(room.uploadedImages).length === 2) {
                const imgArray = Object.values(room.uploadedImages);
                const selectedImg = imgArray[Math.floor(Math.random() * imgArray.length)];
                room.uploadedImages = {}; // Reset kho ảnh tạm
                startRoundGame(roomId, selectedImg);
            } else {
                socket.emit('waitingForOtherImage');
            }
        }
    });

    // 4. Đồng bộ tiến độ kéo hình
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

    // 5. Xử lý Thắng Ván
    socket.on('playerWin', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room || !room.isRoundActive) return;

        room.isRoundActive = false;
        room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

        const maxWins = Math.ceil(room.boType / 2);
        const p1Score = room.scores[room.players[0].id];
        const p2Score = room.scores[room.players[1].id];

        // Kiểm tra xem đã ai thắng Series chưa
        if (p1Score >= maxWins || p2Score >= maxWins) {
            io.to(roomId).emit('matchOver', {
                winner: username,
                scores: room.scores,
                players: room.players
            });
            delete rooms[roomId]; // Xóa phòng sau khi hoàn thành series
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
            io.to(roomId).emit('updatePlayers', rooms[roomId].players);
            if (rooms[roomId].players.length === 0) delete rooms[roomId];
        }
    });
});

// Hàm xác định ai có quyền chọn ảnh theo Round
function getPickerForRound(round, boType) {
    if (boType === 1) return 'RANDOM';
    if (boType === 3) {
        if (round === 1) return 0; // Host (P1)
        if (round === 2) return 1; // Đối thủ (P2)
        return 'RANDOM';           // Round 3
    }
    if (boType === 5) {
        if (round === 1) return 0;
        if (round === 2) return 1;
        if (round === 3) return 0;
        if (round === 4) return 1;
        return 'RANDOM';           // Round 5
    }
}

function startRoundGame(roomId, imageSrc) {
    const room = rooms[roomId];
    room.isRoundActive = true;
    io.to(roomId).emit('gameStarted', {
        imageSrc,
        totalPieces: 16,
        currentRound: room.currentRound,
        scores: room.scores,
        players: room.players
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
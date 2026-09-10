const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname + '/public'));

let rooms = {};
let rankedQueue = null; // Hàng chờ Matchmaking Rank

io.on('connection', (socket) => {

    // 1. Tìm hoặc Tạo phòng tự động cho Đánh Hạng (Matchmaking)
    socket.on('findRankedMatch', ({ username, avatar, lp }) => {
        if (rankedQueue && rankedQueue.socketId !== socket.id && rooms[rankedQueue.roomId]) {
            // Ghép đối thủ vào phòng đang chờ
            const roomId = rankedQueue.roomId;
            const room = rooms[roomId];
            
            room.players.push({
                id: socket.id,
                username: username || 'Player 2',
                avatar: avatar || '',
                lp: lp || 0,
                isHost: false
            });
            room.scores[socket.id] = 0;
            socket.join(roomId);

            rankedQueue = null; // Xóa khỏi hàng chờ

            io.to(roomId).emit('updateRoomState', {
                roomId,
                players: room.players,
                boType: room.boType,
                gridSize: room.gridSize,
                hintPieces: room.hintPieces,
                showHint: room.showHint,
                mode: room.mode
            });
        } else {
            // Tạo phòng Rank mới và đưa vào Hàng chờ
            const roomId = 'RANK_' + Math.random().toString(36).substring(2, 7).toUpperCase();
            rooms[roomId] = createRoomObject('ranked');
            const room = rooms[roomId];

            room.players.push({
                id: socket.id,
                username: username || 'Player 1',
                avatar: avatar || '',
                lp: lp || 0,
                isHost: true
            });
            room.scores[socket.id] = 0;
            socket.join(roomId);

            rankedQueue = { socketId: socket.id, roomId };

            socket.emit('updateRoomState', {
                roomId,
                players: room.players,
                boType: room.boType,
                gridSize: room.gridSize,
                hintPieces: room.hintPieces,
                showHint: room.showHint,
                mode: room.mode
            });
        }
    });

    // 2. Vào / Tạo phòng cụ thể (Sử dụng cho Đánh Thường & Tìm Mã Phòng)
    socket.on('joinRoom', ({ roomId, username, avatar, mode }) => {
        // Tự sinh mã nếu không truyền mã
        if (!roomId) {
            roomId = 'ROOM_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = createRoomObject(mode || 'normal');
        }

        const room = rooms[roomId];
        
        if (room.players.length < 2) {
            const isAlreadyIn = room.players.some(p => p.id === socket.id);
            if (!isAlreadyIn) {
                room.players.push({ 
                    id: socket.id, 
                    username: username || 'Player', 
                    avatar: avatar || '', 
                    isHost: room.players.length === 0 
                });
                room.scores[socket.id] = 0;
            }
        } else {
            socket.emit('roomFull', { msg: 'Phòng đã đầy!' });
            return;
        }

        io.to(roomId).emit('updateRoomState', {
            roomId,
            players: room.players,
            boType: room.boType,
            gridSize: room.gridSize,
            hintPieces: room.hintPieces,
            showHint: room.showHint,
            mode: room.mode
        });
    });

    // 3. Cập nhật Cài Đặt Phòng (Chủ phòng)
    socket.on('updateRoomSettings', ({ roomId, boType, gridSize, hintPieces, showHint }) => {
        const room = rooms[roomId];
        if (room) {
            room.boType = parseInt(boType) || 3;
            room.gridSize = parseInt(gridSize) || 4;
            room.hintPieces = parseInt(hintPieces) || 0;
            room.showHint = (showHint === true || showHint === 'true');

            io.to(roomId).emit('updateRoomState', {
                roomId,
                players: room.players,
                boType: room.boType,
                gridSize: room.gridSize,
                hintPieces: room.hintPieces,
                showHint: room.showHint,
                mode: room.mode
            });
        }
    });

    // 4. Xử lý Nộp Ảnh
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

    // 5. Cập nhật tiến độ ghép
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

    // 6. Thắng ván
    socket.on('playerWin', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room || !room.isRoundActive) return;

        room.isRoundActive = false;
        room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

        const maxWins = Math.ceil(room.boType / 2);
        const p1Score = room.scores[room.players[0].id] || 0;
        const p2Score = room.players[1] ? (room.scores[room.players[1].id] || 0) : 0;

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

    // 7. Xử lý ngắt kết nối
    socket.on('disconnect', () => {
        if (rankedQueue && rankedQueue.socketId === socket.id) {
            rankedQueue = null;
        }

        for (let roomId in rooms) {
            const room = rooms[roomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            delete room.scores[socket.id];

            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('updateRoomState', {
                    roomId,
                    players: room.players,
                    boType: room.boType,
                    gridSize: room.gridSize,
                    hintPieces: room.hintPieces,
                    showHint: room.showHint,
                    mode: room.mode
                });
            }
        }
    });
});

function createRoomObject(mode) {
    return {
        mode: mode || 'normal',
        players: [],
        boType: 3,
        gridSize: 4,
        hintPieces: 0,
        showHint: true,
        currentRound: 1,
        uploadedImages: {},
        scores: {},
        isRoundActive: false
    };
}

function getPickerForRound(round, boType) {
    if (boType === 1) return 'RANDOM';
    if (boType === 3) {
        if (round === 1) return 0;
        if (round === 2) return 1;
        return 'RANDOM';
    }
    if (boType === 5) {
        if (round === 1) return 0;
        if (round === 2) return 1;
        if (round === 3) return 0;
        if (round === 4) return 1;
        return 'RANDOM';
    }
}

function startRoundGame(roomId, imageSrc) {
    const room = rooms[roomId];
    if (!room) return;
    
    room.isRoundActive = true;
    io.to(roomId).emit('gameStarted', {
        imageSrc,
        gridSize: room.gridSize,
        hintPieces: room.hintPieces,
        showHint: room.showHint,
        currentRound: room.currentRound,
        scores: room.scores,
        players: room.players
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));

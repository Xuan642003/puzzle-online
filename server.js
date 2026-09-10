const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.static(__dirname + '/public'));

let rooms = {};
let rankedQueue = null;

// Hàm lấy danh sách ảnh ngẫu nhiên từ thư mục public/preset_images
function getRandomPresetImage() {
    const dirPath = path.join(__dirname, 'public', 'preset_images');
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        const files = fs.readdirSync(dirPath).filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file));
        if (files.length > 0) {
            const randomFile = files[Math.floor(Math.random() * files.length)];
            return `/preset_images/${randomFile}`;
        }
    } catch (err) {
        console.error("Lỗi đọc thư mục preset_images:", err);
    }
    // Ảnh fallback nếu thư mục rỗng
    return 'https://picsum.photos/800/800';
}

io.on('connection', (socket) => {

    // 1. Tìm hoặc Tạo phòng cho ĐÁNH HẠNG (Cố định BO1 + Random Ảnh Preset)
    socket.on('findRankedMatch', ({ username, avatar, lp }) => {
        if (rankedQueue && rankedQueue.socketId !== socket.id && rooms[rankedQueue.roomId]) {
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

            rankedQueue = null;

            io.to(roomId).emit('updateRoomState', {
                roomId,
                players: room.players,
                boType: room.boType,
                gridSize: room.gridSize,
                hintPieces: room.hintPieces,
                showHint: room.showHint,
                mode: room.mode
            });

            // Đấu Hạng -> Tự động bắt đầu ngay với ảnh Random Preset
            setTimeout(() => {
                const randomImg = getRandomPresetImage();
                startRoundGame(roomId, randomImg);
            }, 1000);

        } else {
            const roomId = 'RANK_' + Math.random().toString(36).substring(2, 7).toUpperCase();
            rooms[roomId] = createRoomObject('ranked');
            const room = rooms[roomId];
            room.boType = 1; // Cố định Rank là BO1

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

    // 2. Tạo/Vào phòng ĐÁNH THƯỜNG
    socket.on('joinRoom', ({ roomId, username, avatar, mode }) => {
        if (!roomId) {
            roomId = 'ROOM_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = createRoomObject(mode || 'normal');
        }

        const room = rooms[roomId];
        const existingPlayer = room.players.find(p => p.id === socket.id);

        if (!existingPlayer) {
            if (room.players.length < 2) {
                room.players.push({ 
                    id: socket.id, 
                    username: username || 'Player', 
                    avatar: avatar || '', 
                    isHost: room.players.length === 0 
                });
                room.scores[socket.id] = 0;
            } else {
                socket.emit('roomFull', { msg: 'Phòng đã đầy!' });
                return;
            }
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

    // 3. Cập nhật cài đặt phòng
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

            if (Object.keys(room.uploadedImages).length >= room.players.length) {
                const imgArray = Object.values(room.uploadedImages);
                const selectedImg = imgArray[Math.floor(Math.random() * imgArray.length)];
                room.uploadedImages = {};
                startRoundGame(roomId, selectedImg);
            } else {
                socket.emit('waitingForOtherImage');
            }
        }
    });

    // 5. Đồng bộ Tiến độ
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

    // 6. Xử lý Thắng Ván (Sửa triệt để lỗi BO3)
    socket.on('playerWin', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room || !room.isRoundActive) return;

        room.isRoundActive = false;
        room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;

        const maxWins = Math.ceil(room.boType / 2);
        const p1 = room.players[0];
        const p2 = room.players[1];

        const p1Score = p1 ? (room.scores[p1.id] || 0) : 0;
        const p2Score = p2 ? (room.scores[p2.id] || 0) : 0;

        if (p1Score >= maxWins || p2Score >= maxWins) {
            io.to(roomId).emit('matchOver', {
                winner: username,
                scores: room.scores,
                players: room.players,
                mode: room.mode
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
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                room.players.splice(pIndex, 1);
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

const path = require('path');

// Phục vụ các file tĩnh trong thư mục public
app.use(express.static(path.join(__dirname, 'public')));

// Route riêng cho trang Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
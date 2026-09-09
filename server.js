const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname + '/public'));

let rooms = {}; // Lưu danh sách phòng chơi

io.on('connection', (socket) => {
    console.log('Người chơi kết nối:', socket.id);

    // Tạo hoặc Tham gia phòng
    socket.on('joinRoom', ({ roomId, username }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], gameState: null, imageSrc: null };
        }

        rooms[roomId].players.push({ id: socket.id, username, progress: 0, isWin: false });

        // Gửi danh sách người chơi trong phòng cho mọi người
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);

        // Nếu phòng đủ 2 người chơi -> Cho phép bắt đầu
        if (rooms[roomId].players.length === 2) {
            io.to(roomId).emit('roomReady', 'Phòng đã đủ 2 người! Chủ phòng có thể bắt đầu.');
        }
    });

    // Chủ phòng tải ảnh lên và gửi thông tin trận đấu cho người còn lại
    socket.on('startGame', ({ roomId, imageSrc, totalPieces }) => {
        if (rooms[roomId]) {
            rooms[roomId].imageSrc = imageSrc;
            rooms[roomId].totalPieces = totalPieces;
            // Phát sự kiện bắt đầu game tới cả 2 máy
            io.to(roomId).emit('gameStarted', { imageSrc, totalPieces });
        }
    });

    // Đồng bộ tiến độ xếp hình (Ví dụ: Đã ghép được bao nhiêu mảnh)
    socket.on('updateProgress', ({ roomId, placedPieces, totalPieces }) => {
        if (rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            if (player) {
                player.progress = Math.round((placedPieces / totalPieces) * 100);
                io.to(roomId).emit('playerProgressUpdate', {
                    socketId: socket.id,
                    username: player.username,
                    progress: player.progress
                });
            }
        }
    });

    // Xử lý khi có 1 người chiến thắng
    socket.on('playerWin', ({ roomId, username }) => {
        io.to(roomId).emit('gameOver', { winner: username });
    });

    // Xử lý khi ngắt kết nối
    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            io.to(roomId).emit('updatePlayers', rooms[roomId].players);
            if (rooms[roomId].players.length === 0) {
                delete rooms[roomId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
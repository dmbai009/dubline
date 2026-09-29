// Подключение игрока: общие для всех обработчиков данные соединения и регистрация обработчиков
const { io } = require('../app');
const registerRoomHandlers = require('./room');
const registerRoleHandlers = require('./roles');
const registerHostHandlers = require('./host');
const registerTrashHandlers = require('./trash');
const registerP2pHandlers = require('./p2p');

io.on('connection', socket => {
  // Меняются при входе в комнату и смене ника; обработчики читают их в момент вызова
  const conn = { roomId: null, nick: '', clientId: '' };
  registerRoomHandlers(socket, conn);
  registerRoleHandlers(socket, conn);
  registerHostHandlers(socket, conn);
  registerTrashHandlers(socket, conn);
  registerP2pHandlers(socket, conn);
});
